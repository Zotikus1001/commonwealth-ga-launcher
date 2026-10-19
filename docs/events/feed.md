# Server event feed

Edit `server-events.yaml` at the repository root. Its comments include the short editing guide and
example. The feed URL is centralized as `server_events_url` in `launcher.config.yml`, currently the
origin repository's raw `master/server-events.yaml`. Publishing only that YAML updates launchers
that already support this feed; deploying the initial feed-capable launcher still needs a release.

Every process startup checks the feed once, including headless reminder starts. The main window
does not wait for the network. Event UI and scheduler reconciliation wait for the bounded fetch so
they use the same validated snapshot. An already-running instance retains its startup snapshot.

The build validates and bundles the same YAML as the first-launch offline fallback. Later launches
prefer the validated cache under userData (`server-events-cache.json`). Conditional requests send
ETag/Last-Modified; a 304 retains the cache without rewriting it. Network, timeout, HTTP, oversized,
encoding and validation failures preserve the last valid schedule. Fetches have an eight-second
deadline and a 128 KiB body limit. Cache writes use a temporary file and atomic rename.

Events are weekly in Europe/London; the UI converts them to local time. Names, weekdays and HH:MM
times are validated. Up to 100 events are accepted. Names must be unique after Unicode normalization,
case and whitespace normalization. Names are limited to 100 characters and descriptions to
1000; unknown fields are rejected to catch typos. Sunday 01:00–01:59 is rejected because the London
clock skips or repeats that hour. Removing every block (a blank or comments-only file) removes all
events; invalid files retain the fallback. Multiple events can share a weekday; the spotlight chooses the earliest
upcoming event, or the latest event whose live window has begun.

Reminder identity comes only from the normalized name, never the time or description. The three
original event names retain their legacy identities and OS names. New names use SHA-256 identities
for safe, bounded task names, unit names and arguments. Existing schema-1 reminder preferences remain
compatible. New names start disabled; changing day/time preserves the opt-in and replaces the native
schedule. Renames/removals remove the old schedule and opt-in. Cleanup failures retain the old identity
for retry, but stale invocations cannot notify for removed events. Re-adding a successfully removed
name starts disabled. Concurrent preference changes are serialized to prevent lost updates.

Windows reconciles the next exact London start; Linux compares both the saved calendar and the loaded
timer's schedule description. Both retain native weekly recurrence. Development reminder names stay
isolated. Manual Windows installs/uninstalls clean up legacy names and exact hashed event names;
in-app updates preserve preferences and tasks for startup reconciliation.
