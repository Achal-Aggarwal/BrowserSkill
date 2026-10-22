import { useTranslation } from "@browser-skill/i18n/react";
import { useEffect, useState } from "react";
import { COOPERATION_CONTROL, type CooperationView } from "@/cooperation/types";

function AgentTarget({ target }: { target?: CooperationView["target"] }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!target) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, target.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [target]);
  if (!target || expired || target.expires <= Date.now()) return null;
  return (
    <div
      className="bsk-cooperation-target"
      aria-hidden="true"
      style={{ left: target.x, top: target.y }}
    >
      Agent
    </div>
  );
}

export function CooperationOverlay({ state, onStop }: { state?: CooperationView; onStop(): void }) {
  const { t } = useTranslation("extension");
  const [pending, setPending] = useState(false);
  if (!state) return null;
  const control = async (action: "hold" | "resume") => {
    setPending(true);
    try {
      await chrome.runtime.sendMessage({
        kind: COOPERATION_CONTROL,
        revision: state.revision,
        action,
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <AgentTarget target={state.target} />
      <div
        className="bsk-cooperation"
        data-slot="cooperation-toolbar"
        data-mode={state.mode}
        role="toolbar"
        aria-label={t("cooperation.label")}
        onPointerDown={(event) => event.preventDefault()}
      >
        <span className={`bsk-cooperation-dot bsk-cooperation-${state.mode}`} />
        <span role="status" aria-live="polite">
          {t(`cooperation.${state.editing && state.mode === "human" ? "editing" : state.mode}`)}
        </span>
        <button
          type="button"
          disabled={pending || state.mode === "yielding"}
          onClick={() =>
            void control(state.mode === "held" || state.mode === "human" ? "resume" : "hold")
          }
        >
          {t(
            state.mode === "held" || state.mode === "human"
              ? "cooperation.resume"
              : "cooperation.hold",
          )}
        </button>
        <button type="button" onClick={onStop}>
          {t("cooperation.stop")}
        </button>
      </div>
    </>
  );
}
