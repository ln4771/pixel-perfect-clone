import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import type { JunctionSummary } from "@/lib/traffic-data";

const LEVEL_COLOR: Record<string, string> = {
  LOW: "var(--signal-low)",
  MODERATE: "var(--signal-moderate)",
  HIGH: "var(--signal-high)",
};

type Props = {
  junctions: JunctionSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
};

export default function JunctionMap({ junctions, selectedId, onSelect }: Props) {
  const center: [number, number] = [12.845, 80.045];

  return (
    <MapContainer
      center={center}
      zoom={11}
      scrollWheelZoom
      className="h-full w-full"
      attributionControl
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      {junctions.map((junction) => {
        const color = LEVEL_COLOR[junction.congestion_level] ?? LEVEL_COLOR['LOW'];
        const selected = junction.junction_id === selectedId;
        return (
          <CircleMarker
            key={junction.junction_id}
            center={[junction.latitude, junction.longitude]}
            radius={selected ? 15 : 10}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: selected ? 0.55 : 0.3,
              weight: selected ? 3 : 2,
            }}
            eventHandlers={{ click: () => onSelect(junction.junction_id) }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1}>
              <span className="font-medium">{junction.name}</span>
              <br />
              {junction.congestion_level} · avg {junction.avg_vehicle_count} veh
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
