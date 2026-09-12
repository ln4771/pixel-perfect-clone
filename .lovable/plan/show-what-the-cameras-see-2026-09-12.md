# Show what the cameras see

Right now clicking a signal shows the green times and a detection graph, but nothing that tells you *where* the numbers come from. This adds a four-camera wall for the selected signal, so every count on screen can be traced back to a camera watching a specific approach.

## What you will see

For the selected signal, a grid of four camera views — one per approach (North, South, East, West):

- A generated top-down view of that approach's road, with vehicles drawn queued at the stop line. The number of vehicles on screen is exactly the count the model is using for that approach, so the picture and the numbers always agree.
- Green detection boxes around each vehicle, with the detector's confidence, the frame number counting up, and a live dot — the same look as a real detection feed.
- A caption per view: camera name, the direction it watches, whether that approach currently has the green, and its latest reading with timestamp.
- The signal head in each view turns green or red in step with the live phase, and vehicles at the front pull away while that approach is green.
- A clear "Simulated view" note on the wall, consistent with the existing simulated-demand label: there is no public video feed from Chennai's cameras, so the scene is drawn from the live model rather than filmed.
- Any camera marked offline shows a "signal lost" state instead of a scene, so faults are visible.

The existing detection graph stays below the wall as the history of what those cameras reported.

On a phone the four views stack into a single scrolling column.

## Technical notes

- New `CameraWall.tsx` component under `src/components/traffic/`, rendering four `CameraTile` views. Each tile is a lightweight canvas/SVG scene: lane, stop line, signal head, and one vehicle sprite per queued vehicle (capped with a "+N more" marker so heavy queues stay readable), plus detection rectangles and an HUD overlay.
- Data comes from existing sources, no schema change: `fetchRoadStates` (vehicle count, green flag, phase countdown, capacity) joined to `cctv_cameras` by `road_id` for camera name and status, and the latest `cctv_analysis_log` row per camera for frame number and confidence. Extend `fetchCctvFeed` in `src/lib/traffic-data.ts` with a `fetchCameraTiles(junctionId)` returning one row per camera, or widen the existing query to keep one round trip.
- Vehicle placement is deterministic per road and frame (seeded from `road_id` + frame number) so tiles don't jitter between refreshes; animation is CSS/`requestAnimationFrame` only, no new dependency.
- Reuses the 2s road refetch already in place for the live phase countdown; tiles re-render off that data rather than adding their own polling.
- Colours use existing tokens (`signal-low`, `signal-high`, `surface`, `border`); no hardcoded colours.
- `src/routes/index.tsx` renders `CameraWall` above `CctvPanel` in the selected-signal column.
