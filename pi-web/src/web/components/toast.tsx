import { useEffect } from "preact/hooks";
import type { Toast } from "../state.ts";

export function Toast({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 3000);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  return <div class={"toast " + toast.kind}>{toast.text}</div>;
}
