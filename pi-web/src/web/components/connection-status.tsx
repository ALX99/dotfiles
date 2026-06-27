export function ConnectionStatus({
  connected,
  attempt,
}: {
  connected: boolean;
  attempt: number;
}) {
  const label = connected
    ? "Connected"
    : attempt > 0
      ? `Reconnecting… (${attempt})`
      : "Connecting…";
  return (
    <div class="connection">
      <span class={"dot " + (connected ? "on" : "off")} />
      {label}
    </div>
  );
}
