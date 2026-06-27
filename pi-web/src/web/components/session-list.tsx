import type { SessionSummary } from "../../shared/wire.ts";

const MAX_LABEL = 60;

function relativeTime(ts: number | undefined): string {
  if (ts === undefined) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function label(s: SessionSummary): string {
  if (s.name) return s.name;
  if (s.firstMessage && s.firstMessage !== "(no messages)") {
    return s.firstMessage.length > MAX_LABEL
      ? s.firstMessage.slice(0, MAX_LABEL) + "…"
      : s.firstMessage;
  }
  return s.id;
}

export function SessionList({
  sessions,
  currentPath,
  onNew,
  onSwitch,
}: {
  sessions: SessionSummary[];
  currentPath: string | null;
  onNew: () => void;
  onSwitch: (path: string) => void;
}) {
  return (
    <div>
      <button class="new-session" onClick={onNew}>
        + New session
      </button>
      <ul class="session-list">
        {sessions.length === 0 ? (
          <li>(no sessions yet)</li>
        ) : (
          sessions.map((s) => {
            const rel = relativeTime(s.startedAt);
            const title = rel ? `${s.path} · ${rel}` : s.path;
            return (
              <li
                key={s.path}
                class={s.path === currentPath ? "active" : ""}
                onClick={() => onSwitch(s.path)}
                title={title}
              >
                {label(s)}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
