import { createServerFn } from "@tanstack/react-start";

const TOTAL_CYCLE_SEC = 120;
const MIN_GREEN = 15;
const MAX_GREEN = 90;
const BASELINE_FIXED_SEC = 30;

type RoadRow = { road_id: number; junction_id: number; direction: string };

/** Deterministic per-road "personality" so each road keeps a familiar range. */
function baselineFor(roadId: number) {
  const seed = Math.sin(roadId * 12.9898) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return 18 + Math.round(frac * 42); // 18 - 60 vehicles
}

/** Chennai (UTC+5:30) rush hour shaping. */
function timeOfDayFactor(now: Date) {
  const istHour = (now.getUTCHours() + 5.5 + now.getUTCMinutes() / 60) % 24;
  if (istHour >= 8 && istHour < 10) return 1.75;
  if (istHour >= 17 && istHour < 20) return 1.9;
  if (istHour >= 10 && istHour < 17) return 1.15;
  if (istHour >= 20 && istHour < 23) return 0.9;
  return 0.45;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Simulation tick: generates fresh sensor readings, re-allocates green time
 * proportionally across each junction's approaches, logs the decision, and
 * occasionally emits a CCTV-analysis reading as a second data source.
 */
export const runTrafficTick = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: roads, error: roadsError } = await supabaseAdmin
    .from("roads")
    .select("road_id, junction_id, direction")
    .order("road_id");
  if (roadsError) throw new Error(roadsError.message);
  const roadRows = (roads ?? []) as RoadRow[];
  if (roadRows.length === 0) return { ok: true, cycles: 0 };

  const now = new Date();
  const factor = timeOfDayFactor(now);

  const { data: prevCounts } = await supabaseAdmin
    .from("vehicle_counts")
    .select("road_id, vehicle_count, recorded_at")
    .order("recorded_at", { ascending: false })
    .limit(400);

  const previous = new Map<number, number>();
  for (const row of (prevCounts ?? []) as Array<{ road_id: number; vehicle_count: number }>) {
    if (!previous.has(row.road_id)) previous.set(row.road_id, row.vehicle_count);
  }

  const counts = new Map<number, number>();
  const sensorRows: Array<{ road_id: number; vehicle_count: number; source: string }> = [];

  for (const road of roadRows) {
    const target = baselineFor(road.road_id) * factor;
    const noisy = target * (0.75 + Math.random() * 0.5); // +/- 25% noise
    const prev = previous.get(road.road_id) ?? target;
    const smoothed = clamp(Math.round(prev * 0.45 + noisy * 0.55), 3, 120);
    counts.set(road.road_id, smoothed);
    sensorRows.push({
      road_id: road.road_id,
      vehicle_count: smoothed,
      source: "SIMULATED_SENSOR",
    });
  }

  await supabaseAdmin.from("vehicle_counts").insert(sensorRows);

  // Latest cycle number per junction
  const { data: lastCycles } = await supabaseAdmin
    .from("signal_history")
    .select("junction_id, cycle_number")
    .order("history_id", { ascending: false })
    .limit(600);
  const cycleByJunction = new Map<number, number>();
  for (const row of (lastCycles ?? []) as Array<{ junction_id: number; cycle_number: number }>) {
    const current = cycleByJunction.get(row.junction_id) ?? 0;
    if ((row.cycle_number ?? 0) > current) cycleByJunction.set(row.junction_id, row.cycle_number ?? 0);
  }

  const byJunction = new Map<number, RoadRow[]>();
  for (const road of roadRows) {
    const list = byJunction.get(road.junction_id) ?? [];
    list.push(road);
    byJunction.set(road.junction_id, list);
  }

  const historyRows: Array<{
    junction_id: number;
    road_id: number;
    vehicle_count_at_decision: number;
    allocated_green_sec: number;
    baseline_fixed_sec: number;
    estimated_wait_saved_sec: number;
    cycle_number: number;
  }> = [];
  const timingUpdates: Array<{ road_id: number; green: number; green_now: boolean }> = [];

  for (const [junctionId, junctionRoads] of byJunction) {
    const total = junctionRoads.reduce((sum, r) => sum + (counts.get(r.road_id) ?? 0), 0) || 1;
    const cycle = (cycleByJunction.get(junctionId) ?? 0) + 1;
    let busiestId = junctionRoads[0]?.road_id ?? -1;
    for (const road of junctionRoads) {
      if ((counts.get(road.road_id) ?? 0) > (counts.get(busiestId) ?? 0)) busiestId = road.road_id;
    }

    for (const road of junctionRoads) {
      const count = counts.get(road.road_id) ?? 0;
      const green = clamp(Math.round((TOTAL_CYCLE_SEC * count) / total), MIN_GREEN, MAX_GREEN);
      const saved = Math.max(0, Math.round(((green - BASELINE_FIXED_SEC) * count) / 20));
      timingUpdates.push({
        road_id: road.road_id,
        green,
        green_now: road.road_id === busiestId,
      });
      historyRows.push({
        junction_id: junctionId,
        road_id: road.road_id,
        vehicle_count_at_decision: count,
        allocated_green_sec: green,
        baseline_fixed_sec: BASELINE_FIXED_SEC,
        estimated_wait_saved_sec: saved,
        cycle_number: cycle,
      });
    }
  }

  await Promise.all(
    timingUpdates.map((update) =>
      supabaseAdmin
        .from("signal_timings")
        .update({
          green_duration_sec: update.green,
          is_currently_green: update.green_now,
          updated_at: new Date().toISOString(),
        })
        .eq("road_id", update.road_id),
    ),
  );

  await supabaseAdmin.from("signal_history").insert(historyRows);

  // Simulated CCTV vehicle detection on a couple of random approaches
  const cctvRoads = roadRows.filter(() => Math.random() < 0.25).slice(0, 6);
  if (cctvRoads.length > 0) {
    const { data: cameras } = await supabaseAdmin
      .from("cctv_cameras")
      .select("camera_id, road_id")
      .in(
        "road_id",
        cctvRoads.map((r) => r.road_id),
      );
    const { data: lastFrames } = await supabaseAdmin
      .from("cctv_analysis_log")
      .select("camera_id, frame_number")
      .order("analysis_id", { ascending: false })
      .limit(200);
    const frameByCamera = new Map<number, number>();
    for (const row of (lastFrames ?? []) as Array<{ camera_id: number; frame_number: number }>) {
      if (!frameByCamera.has(row.camera_id)) frameByCamera.set(row.camera_id, row.frame_number ?? 0);
    }

    const analysisRows: Array<{
      camera_id: number;
      frame_number: number;
      vehicles_detected: number;
      confidence_avg: number;
    }> = [];
    const cctvCounts: Array<{ road_id: number; vehicle_count: number; source: string }> = [];
    for (const camera of (cameras ?? []) as Array<{ camera_id: number; road_id: number }>) {
      const sensorCount = counts.get(camera.road_id) ?? 20;
      const detected = clamp(Math.round(sensorCount * (0.85 + Math.random() * 0.3)), 1, 130);
      analysisRows.push({
        camera_id: camera.camera_id,
        frame_number: (frameByCamera.get(camera.camera_id) ?? 0) + 1,
        vehicles_detected: detected,
        confidence_avg: Number((0.82 + Math.random() * 0.16).toFixed(3)),
      });
      cctvCounts.push({
        road_id: camera.road_id,
        vehicle_count: detected,
        source: "CCTV_ANALYSIS",
      });
    }
    if (analysisRows.length > 0) {
      await supabaseAdmin.from("cctv_analysis_log").insert(analysisRows);
      await supabaseAdmin.from("vehicle_counts").insert(cctvCounts);
    }
  }

  return { ok: true, cycles: byJunction.size, at: new Date().toISOString() };
});
