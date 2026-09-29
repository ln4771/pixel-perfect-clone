# Expand to city-wide Chennai coverage

Today the dashboard tracks 5 junctions with 20 approaches and 20 cameras. This expands it to a realistic city-wide network of roughly 60 major Chennai signalised junctions, and updates the interface so a map with that many points stays readable.

## Junction coverage

Add about 55 more well-known Chennai signals with real coordinates, grouped by zone, for example:

- Central: Anna Salai/Gemini, Teynampet, Nandanam, Saidapet Bridge, Guindy, Kathipara, Alandur, Little Mount, Egmore, Chetpet, Choolaimedu, Vadapalani, Ashok Pillar, Kodambakkam Bridge
- North: Broadway, Central Station, Parry's, Basin Bridge, Vyasarpadi, Tondiarpet, Washermanpet, Perambur, Villivakkam, Ambattur, Padi flyover
- South: Adyar signal, Madhya Kailash, Tidel Park, Thiruvanmiyur, Perungudi, Sholinganallur, Navalur, Siruseri, Velachery, Medavakkam, Pallikaranai, Thoraipakkam
- West: Koyambedu, Maduravoyal, Porur, Vadapalani, Valasaravakkam, Alwarthirunagar, Virugambakkam, Poonamallee bypass, Nerkundram
- Outer/other: Tambaram, Chromepet, Pallavaram, Vandalur, Avadi, Thiruninravur, Red Hills, Manali, Ennore, Thiruvottiyur, Mount Poonamallee Road

Each junction gets 4 approaches (N/E/S/W) with names and capacities matched to road size (arterial roads get higher capacity), one camera per approach, plus starting vehicle counts, signal timings and a first history entry so the dashboard is populated immediately.

## Interface changes for a bigger network

- Map: cluster/zoom-aware markers so dense areas stay usable; auto-fit to the city; marker size reflects traffic volume, colour reflects congestion.
- New junction sidebar list with search by name and filters by zone and congestion level (High / Medium / Low), showing live vehicle counts; clicking selects the junction on the map.
- Header metrics become city-wide: total junctions, vehicles across the network, count of congested junctions, total waiting time saved.
- Simulation loop updates the whole network per tick in batched writes rather than one junction at a time, keeping the refresh cadence responsive.

## Technical notes

- One migration adds a `zone` column to `junctions` plus INSERT statements for the new junctions, roads, cameras, timings, counts and history rows. Existing public read policies and grants already cover the new rows; new column needs no policy change.
- `src/lib/traffic.functions.ts`: rewrite the tick to select all roads with their latest counts in one query, compute allocations per junction in memory, then bulk-insert counts/history and bulk-update timings.
- `src/lib/traffic-data.ts`: extend the junction type with `zone`; keep the `v_junction_congestion` view as the list source (recreate it to expose `zone`).
- `src/components/traffic/JunctionMap.tsx`: switch to a canvas/zoom-thinned marker layer; add `JunctionList.tsx` for search + filters; `src/routes/index.tsx` wires filter state and city-wide metrics.
