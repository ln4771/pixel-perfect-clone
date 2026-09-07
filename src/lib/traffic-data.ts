import { supabase } from "@/integrations/supabase/client";

export type CongestionLevel = "LOW" | "MODERATE" | "HIGH";

export type JunctionSummary = {
  junction_id: number;
  name: string;
  zone: string;
  latitude: number;
  longitude: number;
  avg_vehicle_count: number;
  total_vehicle_count: number;
  congestion_level: CongestionLevel;
  last_reading_at: string | null;
};

export type RoadState = {
  road_id: number;
  direction: string;
  road_name: string | null;
  max_capacity: number;
  vehicle_count: number;
  source: string;
  recorded_at: string | null;
  green_duration_sec: number;
  timing_mode: string;
  is_currently_green: boolean;
};

export type CyclePoint = {
  cycle_number: number;
  adaptive_sec: number;
  fixed_sec: number;
  saved_sec: number;
};

export type CctvPoint = {
  frame_number: number;
  vehicles_detected: number;
  confidence_avg: number;
  camera_name: string;
  analyzed_at: string;
};

const DIRECTION_ORDER = ["NORTH", "EAST", "SOUTH", "WEST"];

export async function fetchJunctions(): Promise<JunctionSummary[]> {
  const { data, error } = await supabase
    .from("v_junction_congestion")
    .select("*")
    .order("junction_id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    junction_id: Number(row['junction_id']),
    name: String(row['name']),
    zone: String(row['zone'] ?? "Central"),
    latitude: Number(row['latitude']),
    longitude: Number(row['longitude']),
    avg_vehicle_count: Number(row['avg_vehicle_count'] ?? 0),
    total_vehicle_count: Number(row['total_vehicle_count'] ?? 0),
    congestion_level: (row['congestion_level'] as CongestionLevel) ?? "LOW",
    last_reading_at: (row['last_reading_at'] as string | null) ?? null,
  }));
}

export async function fetchRoadStates(junctionId: number): Promise<RoadState[]> {
  const { data: roads, error } = await supabase
    .from("roads")
    .select("road_id, direction, road_name, max_capacity")
    .eq("junction_id", junctionId);
  if (error) throw new Error(error.message);
  const roadRows = (roads ?? []) as Array<{
    road_id: number;
    direction: string;
    road_name: string | null;
    max_capacity: number;
  }>;
  const roadIds = roadRows.map((r) => r.road_id);
  if (roadIds.length === 0) return [];

  const [{ data: timings }, { data: counts }] = await Promise.all([
    supabase
      .from("signal_timings")
      .select("road_id, green_duration_sec, timing_mode, is_currently_green")
      .in("road_id", roadIds),
    supabase
      .from("vehicle_counts")
      .select("road_id, vehicle_count, source, recorded_at")
      .in("road_id", roadIds)
      .order("recorded_at", { ascending: false })
      .limit(120),
  ]);

  const timingByRoad = new Map(
    ((timings ?? []) as Array<Record<string, unknown>>).map((t) => [Number(t['road_id']), t]),
  );
  const latestByRoad = new Map<number, Record<string, unknown>>();
  for (const row of (counts ?? []) as Array<Record<string, unknown>>) {
    const id = Number(row['road_id']);
    if (!latestByRoad.has(id)) latestByRoad.set(id, row);
  }

  return roadRows
    .map((road) => {
      const timing = timingByRoad.get(road.road_id);
      const latest = latestByRoad.get(road.road_id);
      return {
        road_id: road.road_id,
        direction: road.direction,
        road_name: road.road_name,
        max_capacity: road.max_capacity,
        vehicle_count: Number(latest?.['vehicle_count'] ?? 0),
        source: String(latest?.['source'] ?? "SIMULATED_SENSOR"),
        recorded_at: (latest?.['recorded_at'] as string | undefined) ?? null,
        green_duration_sec: Number(timing?.['green_duration_sec'] ?? 30),
        timing_mode: String(timing?.['timing_mode'] ?? "ADAPTIVE"),
        is_currently_green: Boolean(timing?.['is_currently_green'] ?? false),
      };
    })
    .sort((a, b) => DIRECTION_ORDER.indexOf(a.direction) - DIRECTION_ORDER.indexOf(b.direction));
}

export async function fetchCycleComparison(junctionId: number): Promise<CyclePoint[]> {
  const { data, error } = await supabase
    .from("signal_history")
    .select("cycle_number, allocated_green_sec, baseline_fixed_sec, estimated_wait_saved_sec")
    .eq("junction_id", junctionId)
    .order("history_id", { ascending: false })
    .limit(120);
  if (error) throw new Error(error.message);

  const byCycle = new Map<number, CyclePoint>();
  for (const row of (data ?? []) as Array<Record<string, number>>) {
    const cycle = Number(row['cycle_number'] ?? 0);
    const point = byCycle.get(cycle) ?? {
      cycle_number: cycle,
      adaptive_sec: 0,
      fixed_sec: 0,
      saved_sec: 0,
    };
    point.adaptive_sec += Number(row['allocated_green_sec'] ?? 0);
    point.fixed_sec += Number(row['baseline_fixed_sec'] ?? 30);
    point.saved_sec += Number(row['estimated_wait_saved_sec'] ?? 0);
    byCycle.set(cycle, point);
  }

  return Array.from(byCycle.values())
    .sort((a, b) => a.cycle_number - b.cycle_number)
    .slice(-15);
}

export async function fetchTotalSecondsSaved(): Promise<number> {
  const { data, error } = await supabase
    .from("signal_history")
    .select("estimated_wait_saved_sec")
    .order("history_id", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ estimated_wait_saved_sec: number }>).reduce(
    (sum, row) => sum + Number(row.estimated_wait_saved_sec ?? 0),
    0,
  );
}

export async function fetchCctvFeed(junctionId: number): Promise<CctvPoint[]> {
  const { data: roads } = await supabase.from("roads").select("road_id").eq("junction_id", junctionId);
  const roadIds = ((roads ?? []) as Array<{ road_id: number }>).map((r) => r.road_id);
  if (roadIds.length === 0) return [];

  const { data: cameras } = await supabase
    .from("cctv_cameras")
    .select("camera_id, camera_name")
    .in("road_id", roadIds);
  const cameraRows = (cameras ?? []) as Array<{ camera_id: number; camera_name: string | null }>;
  if (cameraRows.length === 0) return [];
  const nameById = new Map(cameraRows.map((c) => [c.camera_id, c.camera_name ?? `CAM-${c.camera_id}`]));

  const { data, error } = await supabase
    .from("cctv_analysis_log")
    .select("camera_id, frame_number, vehicles_detected, confidence_avg, analyzed_at")
    .in(
      "camera_id",
      cameraRows.map((c) => c.camera_id),
    )
    .order("analysis_id", { ascending: false })
    .limit(24);
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      frame_number: Number(row['frame_number'] ?? 0),
      vehicles_detected: Number(row['vehicles_detected'] ?? 0),
      confidence_avg: Number(row['confidence_avg'] ?? 0),
      camera_name: nameById.get(Number(row['camera_id'])) ?? "CAM",
      analyzed_at: String(row['analyzed_at']),
    }))
    .reverse();
}
