import { createServerFn } from "@tanstack/react-start";
import {
  FIXED_CYCLE,
  FIXED_GREEN,
  clamp,
  saturationFlow,
  solveJunction,
  type ApproachInput,
} from "@/lib/traffic-model";

const BASELINE_FIXED_SEC = FIXED_GREEN;
/** Nominal seconds between control updates, used when no history exists yet. */
const NOMINAL_TICK_SEC = 12;

type RoadRow = { road_id: number; junction_id: number; direction: string; max_capacity: number };

type ModelStateRow = {
  road_id: number;
  arrival_rate_vph: number;
  green_sec: number;
  cycle_length_sec: number;
  queue_now: number;
  predicted_queue_next: number;
  updated_at: string;
};

/** Deterministic per-road "personality" so each road keeps a familiar range. */
function baselineFor(roadId: number) {
  const seed = Math.sin(roadId * 12.9898) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return 18 + Math.round(frac * 42); // 18 - 60 vehicles
}

/** Chennai (UTC+5:30) rush hour shaping of demand. */
function timeOfDayFactor(now: Date) {
  const istHour = (now.getUTCHours() + 5.5 + now.getUTCMinutes() / 60) % 24;
  if (istHour >= 8 && istHour < 10) return 1.75;
  if (istHour >= 17 && istHour < 20) return 1.9;
  if (istHour >= 10 && istHour < 17) return 1.15;
  if (istHour >= 20 && istHour < 23) return 0.9;
  return 0.45;
}

/**
 * Control tick.
 *
 * 1. Advances the world: arrivals (demand-driven) minus discharge achieved by
 *    the green time that was actually running, so the observed queue responds
 *    to the previous signal decision.
 * 2. Re-estimates arrival rates, solves each junction with Webster's method
 *    and writes the resulting plan, predicted delays and predicted queues.
 * 3. Scores the previous prediction against the new observation.
 */
export const runTrafficTick = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: roads, error: roadsError } = await supabaseAdmin
    .from("roads")
    .select("road_id, junction_id, direction, max_capacity")
    .order("road_id");
  if (roadsError) throw new Error(roadsError.message);
  const roadRows = (roads ?? []) as RoadRow[];
  if (roadRows.length === 0) return { ok: true, cycles: 0 };

  const now = new Date();
  const factor = timeOfDayFactor(now);

  const [{ data: prevCounts }, { data: modelRows }] = await Promise.all([
    supabaseAdmin
      .from("vehicle_counts")
      .select("road_id, vehicle_count, recorded_at")
      .eq("source", "SIMULATED_SENSOR")
      .order("recorded_at", { ascending: false })
      .limit(1600),
    supabaseAdmin
      .from("model_road_state")
      .select(
        "road_id, arrival_rate_vph, green_sec, cycle_length_sec, queue_now, predicted_queue_next, updated_at",
      ),
  ]);

  const previousQueue = new Map<number, number>();
  for (const row of (prevCounts ?? []) as Array<{ road_id: number; vehicle_count: number }>) {
    if (!previousQueue.has(row.road_id)) previousQueue.set(row.road_id, row.vehicle_count);
  }
  const stateByRoad = new Map<number, ModelStateRow>(
    ((modelRows ?? []) as ModelStateRow[]).map((row) => [row.road_id, row]),
  );

  // ---- 1. Advance the physical queues -------------------------------------
  const queues = new Map<number, number>();
  const elapsedByRoad = new Map<number, number>();
  const sensorRows: Array<{ road_id: number; vehicle_count: number; source: string }> = [];

  for (const road of roadRows) {
    const state = stateByRoad.get(road.road_id);
    const elapsed = state
      ? clamp((now.getTime() - new Date(state.updated_at).getTime()) / 1000, 4, 120)
      : NOMINAL_TICK_SEC;
    elapsedByRoad.set(road.road_id, elapsed);

    // Demand for this window, in vehicles, with sensor-level noise.
    // Approach capacity is roughly saturation flow x green share (~450 veh/h),
    // so demand is scaled to sit either side of that depending on the hour.
    const demandVph = baselineFor(road.road_id) * 8 * factor;
    const arrivals = ((demandVph * (0.85 + Math.random() * 0.3)) / 3600) * elapsed;

    // Discharge achieved by the plan that was running during this window.
    const greenShare = state ? state.green_sec / Math.max(state.cycle_length_sec, 1) : FIXED_GREEN / FIXED_CYCLE;
    const served = (saturationFlow(road.max_capacity) / 3600) * greenShare * elapsed;

    const prior = previousQueue.get(road.road_id) ?? arrivals;
    const queue = clamp(Math.round(prior + arrivals - served), 0, 150);
    queues.set(road.road_id, queue);
    sensorRows.push({ road_id: road.road_id, vehicle_count: queue, source: "SIMULATED_SENSOR" });
  }

  await supabaseAdmin.from("vehicle_counts").insert(sensorRows);

  // ---- 2. Score the previous prediction -----------------------------------
  const accuracyRows: Array<{
    road_id: number;
    junction_id: number;
    predicted_queue: number;
    actual_queue: number;
    abs_error: number;
  }> = [];
  for (const road of roadRows) {
    const state = stateByRoad.get(road.road_id);
    if (!state) continue;
    const actual = queues.get(road.road_id) ?? 0;
    accuracyRows.push({
      road_id: road.road_id,
      junction_id: road.junction_id,
      predicted_queue: state.predicted_queue_next,
      actual_queue: actual,
      abs_error: Math.abs(state.predicted_queue_next - actual),
    });
  }

  // ---- 3. Solve every junction --------------------------------------------
  const { data: lastCycles } = await supabaseAdmin
    .from("signal_history")
    .select("junction_id, cycle_number")
    .order("history_id", { ascending: false })
    .limit(1600);
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

  type HistoryRow = {
    junction_id: number;
    road_id: number;
    vehicle_count_at_decision: number;
    allocated_green_sec: number;
    baseline_fixed_sec: number;
    estimated_wait_saved_sec: number;
    cycle_number: number;
    arrival_rate_vph: number;
    saturation_flow_vph: number;
    degree_saturation: number;
    predicted_delay_adaptive_sec: number;
    predicted_delay_fixed_sec: number;
    predicted_queue_next: number;
    cycle_length_sec: number;
  };
  type ModelStateInsert = {
    road_id: number;
    junction_id: number;
    arrival_rate_vph: number;
    saturation_flow_vph: number;
    flow_ratio: number;
    degree_saturation: number;
    green_sec: number;
    cycle_length_sec: number;
    queue_now: number;
    predicted_queue_next: number;
    predicted_delay_adaptive_sec: number;
    predicted_delay_fixed_sec: number;
    queue_clears: boolean;
    updated_at: string;
  };
  const historyRows: HistoryRow[] = [];
  const modelStateRows: ModelStateInsert[] = [];
  const timingUpdates: Array<{ road_id: number; green: number; green_now: boolean }> = [];

  for (const [junctionId, junctionRoads] of byJunction) {
    const elapsed =
      junctionRoads.reduce((sum, r) => sum + (elapsedByRoad.get(r.road_id) ?? NOMINAL_TICK_SEC), 0) /
      junctionRoads.length;

    const inputs: ApproachInput[] = junctionRoads.map((road) => {
      const state = stateByRoad.get(road.road_id);
      const greenShare = state ? state.green_sec / Math.max(state.cycle_length_sec, 1) : FIXED_GREEN / FIXED_CYCLE;
      return {
        roadId: road.road_id,
        queue: queues.get(road.road_id) ?? 0,
        previousQueue: state ? state.queue_now : (previousQueue.get(road.road_id) ?? null),
        // Effective green seconds served inside this observation window.
        previousGreen: greenShare * elapsed,
        previousArrivalRate: state ? Number(state.arrival_rate_vph) : null,
        maxCapacity: road.max_capacity,
      };
    });

    const solution = solveJunction(inputs, elapsed);
    const cycle = (cycleByJunction.get(junctionId) ?? 0) + 1;

    // The approach nearest capacity gets the running green.
    let greenNowRoad = solution.approaches[0]?.roadId ?? -1;
    let worst = -1;
    for (const approach of solution.approaches) {
      if (approach.degreeSaturation > worst) {
        worst = approach.degreeSaturation;
        greenNowRoad = approach.roadId;
      }
    }

    for (const approach of solution.approaches) {
      timingUpdates.push({
        road_id: approach.roadId,
        green: approach.green,
        green_now: approach.roadId === greenNowRoad,
      });

      // Queue expected at the next control update (used to score the model).
      const nextHorizon = elapsed;
      const predictedNextReading = Math.max(
        0,
        Math.round(
          approach.queue +
            (approach.arrivalRateVph / 3600) * nextHorizon -
            (approach.saturationFlowVph / 3600) * (approach.green / solution.cycleLength) * nextHorizon,
        ),
      );

      modelStateRows.push({
        road_id: approach.roadId,
        junction_id: junctionId,
        arrival_rate_vph: approach.arrivalRateVph,
        saturation_flow_vph: approach.saturationFlowVph,
        flow_ratio: approach.flowRatio,
        degree_saturation: approach.degreeSaturation,
        green_sec: approach.green,
        cycle_length_sec: solution.cycleLength,
        queue_now: approach.queue,
        predicted_queue_next: predictedNextReading,
        predicted_delay_adaptive_sec: approach.delayAdaptive,
        predicted_delay_fixed_sec: approach.delayFixed,
        queue_clears: approach.queueClears,
        updated_at: now.toISOString(),
      });

      historyRows.push({
        junction_id: junctionId,
        road_id: approach.roadId,
        vehicle_count_at_decision: approach.queue,
        allocated_green_sec: approach.green,
        baseline_fixed_sec: BASELINE_FIXED_SEC,
        estimated_wait_saved_sec: Math.max(0, approach.savedVehicleSeconds),
        cycle_number: cycle,
        arrival_rate_vph: approach.arrivalRateVph,
        saturation_flow_vph: approach.saturationFlowVph,
        degree_saturation: approach.degreeSaturation,
        predicted_delay_adaptive_sec: approach.delayAdaptive,
        predicted_delay_fixed_sec: approach.delayFixed,
        predicted_queue_next: approach.predictedQueueNext,
        cycle_length_sec: solution.cycleLength,
      });
    }
  }

  // ---- 4. Persist -----------------------------------------------------------
  const { data: timingRows } = await supabaseAdmin
    .from("signal_timings")
    .select("timing_id, road_id, junction_id");
  const timingByRoad = new Map(
    ((timingRows ?? []) as Array<{ timing_id: number; road_id: number; junction_id: number }>).map(
      (t) => [t.road_id, t],
    ),
  );
  const stamp = now.toISOString();
  const upsertRows = timingUpdates
    .map((update) => {
      const existing = timingByRoad.get(update.road_id);
      if (!existing) return null;
      return {
        timing_id: existing.timing_id,
        junction_id: existing.junction_id,
        road_id: update.road_id,
        timing_mode: "ADAPTIVE",
        green_duration_sec: update.green,
        is_currently_green: update.green_now,
        updated_at: stamp,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const chunk = <T,>(rows: T[], size = 200) => {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
  };

  for (const batch of chunk(upsertRows)) {
    await supabaseAdmin.from("signal_timings").upsert(batch, { onConflict: "timing_id" });
  }
  for (const batch of chunk(modelStateRows)) {
    await supabaseAdmin.from("model_road_state").upsert(batch, { onConflict: "road_id" });
  }
  for (const batch of chunk(historyRows, 400)) {
    await supabaseAdmin.from("signal_history").insert(batch);
  }
  if (accuracyRows.length > 0) {
    for (const batch of chunk(accuracyRows, 400)) {
      await supabaseAdmin.from("model_accuracy").insert(batch);
    }
  }

  // ---- 5. CCTV as a second, noisier measurement of the same queue ---------
  const cctvRoads = roadRows.filter(() => Math.random() < 0.25).slice(0, 24);
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
    for (const camera of (cameras ?? []) as Array<{ camera_id: number; road_id: number }>) {
      const queue = queues.get(camera.road_id) ?? 20;
      const detected = clamp(Math.round(queue * (0.88 + Math.random() * 0.24)), 0, 200);
      analysisRows.push({
        camera_id: camera.camera_id,
        frame_number: (frameByCamera.get(camera.camera_id) ?? 0) + 1,
        vehicles_detected: detected,
        confidence_avg: Number((0.82 + Math.random() * 0.16).toFixed(3)),
      });
    }
    if (analysisRows.length > 0) {
      await supabaseAdmin.from("cctv_analysis_log").insert(analysisRows);
    }
  }

  // Keep the rolling window small so the city-wide network stays fast.
  const cutoff = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  await Promise.all([
    supabaseAdmin.from("vehicle_counts").delete().lt("recorded_at", cutoff(25)),
    supabaseAdmin.from("cctv_analysis_log").delete().lt("analyzed_at", cutoff(60)),
    supabaseAdmin.from("signal_history").delete().lt("decided_at", cutoff(90)),
    supabaseAdmin.from("model_accuracy").delete().lt("recorded_at", cutoff(60)),
  ]);

  return { ok: true, cycles: byJunction.size, at: stamp };
});
