---
name: yamap-route
description: Create and verify accurate GPX routes with the local yamap CLI. Use when a user requests a hiking route, GPX route, waypoint, trail, or YAMAP-derived course.
---

# YAMAP route creation

Use the local `yamap` CLI as the primary source and keep all intermediate,
bulky, or machine-readable output in files. Do not paste raw JSON, full GPX,
or large checkpoint lists into the conversation; report concise summaries,
paths, and material findings instead.

## Discover first

Before selecting data or issuing a route command, inspect the installed CLI:

```sh
yamap describe
yamap <command> --help
yamap <command> <subcommand> --help
```

Use the advertised flags, fields, coordinate order, units, and output formats;
do not invent syntax. The CLI is expected to provide:

- `activity summary` and `activity checkpoints`
- `course summary`, `course checkpoints`, and `course gpx`
- `landmarks --bound` and `landmarks --near`
- `route path` and `route build`
- `gpx inspect`, `gpx slice`, `gpx reverse`, `gpx concat`, `gpx validate`,
  and `gpx nearest`
- Existing `resource`, `search`, `track`, and legacy `gpx ID`

Start with focused searches and summaries. Save raw responses to a working
directory, then use summary/checkpoint commands or small derived files to
compare candidates in a batch.

## Source selection and provenance

Prefer sources in this order:

1. Official YAMAP course geometry.
2. Public YAMAP activity tracks that actually cover the requested route.
3. A user-supplied GPX or another source only after explicit user approval.

Never silently download, scrape, or substitute web/external GPX data when
YAMAP cannot supply a required segment. State the missing segment, what YAMAP
sources were checked, and ask whether the user approves an external or
user-supplied source. Do not present an inferred connector as authoritative
geometry.

For every selected source, record its YAMAP ID, type, title, URL/resource
reference when available, retrieval date, and the exact command/file used.
Retain the source geometry and its elevations. Do not flatten elevations,
replace them with guessed elevations, or discard them during slicing,
reversing, concatenating, or route building. If elevation is absent or
incomplete, report that limitation rather than fabricating it.

## Build workflow

1. Translate the request into ordered, testable requirements: start, finish,
   named vias/summits, direction, loop versus out-and-back, date/activity
   constraints, and any required or excluded trails.
2. Search YAMAP and collect summaries for plausible courses and activities.
   Compare distance, elevation, timestamps, public availability, coverage,
   and checkpoint order in a compact table or manifest.
3. Obtain the preferred official course GPX, or public activity geometry when
   no suitable official course exists. Use `gpx inspect` before modifying it.
4. Verify each named waypoint independently. Query nearby and bounded YAMAP
   landmarks, then use `gpx nearest` (or route/path evidence) to measure its
   relationship to the geometry. A label snapped to the nearest line is not
   proof that the requested landmark was visited. Report the matched landmark
   ID/name, distance to geometry, and any ambiguity.
5. Use `gpx slice`, `gpx reverse`, and `gpx concat` only when their geometry
   and direction are understood. Preserve track/route ordering and elevations.
   Use `route path` to inspect candidate connections and `route build` only
   for approved, evidenced route construction. Keep original downloads and
   derived GPX files separate.
6. Produce the final GPX and a small manifest beside it. Include source files
   and IDs so another agent can reproduce the result.

## Required verification

Independently validate the final file; successful command execution is not
enough.

- Inspect the final GPX and verify start, ordered vias, finish, direction, and
  intended loop/out-and-back behavior against the request.
- Use checkpoints and nearest-point checks to confirm each named waypoint in
  order, including a reasonable geometry distance for the terrain.
- Check joins and coverage for coordinate/time/elevation gaps. Investigate
  discontinuities rather than hiding them.
- Check for unwanted closure behavior, dashed/unverified route warnings, and
  route-build caveats. Report any that remain.
- Confirm elevation coverage and plausible ascent/descent; identify missing
  elevation points or mixed source elevation data.
- Run `yamap gpx validate` and retain its result. Also inspect the XML and
  confirm it is well-formed GPX with the expected schema/version and usable
  track/route point sequence.

If a requirement cannot be verified, say so plainly in the final response and
distinguish verified geometry from assumptions.

## Route manifest example

`route build` consumes JSON. External GPX segments are rejected unless the
user approved them and the manifest records that fact:

```json
{
  "name": "Example route",
  "max_join": 100,
  "segments": [
    {
      "activity": 49660845,
      "from": [135.68140, 35.01030],
      "to": [135.66064, 35.03406]
    },
    {
      "gpx": "source/user-approved-spur.gpx",
      "approved_external": true,
      "source_name": "User-approved survey",
      "out_and_back": true
    },
    {"course": 20555}
  ],
  "waypoints": [
    {
      "name": "Kokoromi Pass",
      "coord": [135.66064, 35.03406],
      "verified": true,
      "provenance": "YAMAP activity checkpoint"
    }
  ]
}
```

## Final response

State the output and manifest paths, source choice and provenance, route
distance/elevation, waypoint verification results, and validation outcome.
Call out gaps, warnings, ambiguity, or unverified requirements. Keep raw
artifacts on disk and offer their paths rather than dumping their contents.
