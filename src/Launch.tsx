import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { launchApi, type LaunchPreferences } from "./launchApi";
import { errorMessage } from "./workspaceApi";
import { BrandMark } from "./components/BrandMark";
import { CosmicField } from "./components/CosmicField";
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
type Stage =
  | "loading"
  | "cinematic"
  | "welcome"
  | "name"
  | "greeting"
  | "leaving"
  | "handoff"
  | "settling"
  | "revealing"
  | "done";

function Workspace({ onReady }: { onReady: () => void }) {
  // This effect cannot run until the lazy App has committed through Suspense.
  useEffect(onReady, [onReady]);
  return <App />;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
function useMusic(track: string | null, enabled: boolean) {
  useEffect(() => {
    if (!track || !enabled) return;
    const audio = new Audio(track);
    audio.volume = 0.6;
    let live = true;
    const removeRetry = () => {
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
    };
    // If autoplay is denied, retry on the user's next normal interaction.
    // The intro has no separate sound control; its preference lives in Settings.
    const play = () => {
      void audio
        .play()
        .then(removeRetry)
        .catch(() => {
          if (!live) return;
          window.addEventListener("pointerdown", play);
          window.addEventListener("keydown", play);
        });
    };
    play();
    return () => {
      live = false;
      removeRetry();
      if (audio.paused) {
        audio.removeAttribute("src");
        audio.load();
        return;
      }
      const start = performance.now(),
        volume = audio.volume;
      const fade = setInterval(() => {
        audio.volume =
          volume * Math.max(0, 1 - (performance.now() - start) / 600);
        if (performance.now() - start >= 600) {
          clearInterval(fade);
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
      }, 30);
    };
  }, [track, enabled]);
}

export function Launch() {
  const [prefs, setPrefs] = useState<LaunchPreferences | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [start, setStart] = useState(() => performance.now());
  const [replay, setReplay] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [returnCue, setReturnCue] = useState(false);
  const [formError, setFormError] = useState("");
  const [appMounted, setAppMounted] = useState(false);
  const workspaceReady = useCallback(() => setAppMounted(true), []);
  const [cardSize, setCardSize] = useState({ width: 1280, height: 800 });
  const reduced = useReducedMotion();
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = stage !== "done" && stage !== "loading";
  const transitioning =
    stage === "leaving" ||
    stage === "handoff" ||
    stage === "settling" ||
    stage === "revealing";
  const track = returnCue
    ? "/audio/return.m4a"
    : active && !transitioning
      ? `/audio/welcome.m4a?replay=${start}`
      : null;
  useMusic(track, !!prefs?.music && !error);

  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await launchApi.status();
        if (!live) return;
        setReady(status.ready);
        if (status.error) {
          setError(status.error);
          return;
        }
        if (!status.ready) timer = setTimeout(poll, 150);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    void poll();
    void launchApi
      .preferences()
      .then((p) => {
        if (!live) return;
        setPrefs(p);
        setCardSize({
          width: Math.min(1280, window.innerWidth - 100),
          height: Math.min(800, window.innerHeight - 100),
        });
        setName(p.name);
        setStart(performance.now());
        if (p.completed) {
          setStage("done");
          setReturnCue(true);
        } else
          setStage(p.introSeen ? "name" : reduced ? "welcome" : "cinematic");
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Reduced motion changes after mount are handled without restarting onboarding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  useEffect(() => {
    if (!returnCue) return;
    const timer = setTimeout(() => setReturnCue(false), 4500);
    return () => clearTimeout(timer);
  }, [returnCue]);
  useEffect(() => {
    if (stage !== "cinematic") return;
    if (reduced) {
      setStage("welcome");
      return;
    }
    // The button's animation-end event makes the welcome interactive. A wall-clock
    // timer can run ahead of the compositor and cut the reveal short in WKWebView.
  }, [stage, reduced]);
  useEffect(() => {
    if (stage === "name") input.current?.focus();
    if (stage === "welcome") heading.current?.focus();
  }, [stage]);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const updated = await launchApi.preferences();
      if (live) setPrefs(updated);
      return updated;
    };
    const preferencesChanged = () => {
      void refresh().catch(() => {});
    };
    const replayWelcome = () => {
      void refresh()
        .then(() => {
          if (!live) return;
          setReplay(true);
          setReturnCue(false);
          setStart(performance.now());
          setStage(reduced ? "welcome" : "cinematic");
          setError("");
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    };
    window.addEventListener("workbench-data-changed", preferencesChanged);
    window.addEventListener("brigadier-replay-welcome", replayWelcome);
    return () => {
      live = false;
      window.removeEventListener("brigadier-replay-welcome", replayWelcome);
      window.removeEventListener("workbench-data-changed", preferencesChanged);
    };
  }, [reduced]);
  const leave = useCallback(() => {
    if (appMounted) setStage("leaving");
  }, [appMounted]);
  useEffect(() => {
    if (stage !== "greeting" || !ready || !appMounted || error) return;
    const timer = setTimeout(() => void leave(), reduced ? 200 : 1400);
    return () => clearTimeout(timer);
  }, [stage, ready, appMounted, error, reduced, leave]);
  useEffect(() => {
    if (stage !== "handoff") return;
    let live = true;
    // Native finish installs an independent opaque cover before resizing WebKit.
    void launchApi
      .finish()
      .then(() => {
        if (!live) return;
        setPrefs((p) => (p ? { ...p, desktopReveal: false } : p));
        setStage("settling");
      })
      .catch((e) => {
        if (!live) return;
        setError(errorMessage(e));
        setStage("greeting");
      });
    return () => {
      live = false;
    };
  }, [stage]);
  useEffect(() => {
    if (stage !== "settling") return;
    let live = true,
      frame = 0;
    // App is visible and laid out at the final size beneath both covers. Only
    // release the native cover after a paint; the DOM cover then performs the fade.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void launchApi
          .reveal()
          .then(() => {
            if (live) setStage("revealing");
          })
          .catch((e) => {
            if (live) {
              setError(errorMessage(e));
              setStage("greeting");
            }
          });
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [stage]);
  const completeTransition = () => {
    setStage("done");
    setReplay(false);
    if (!replay)
      window.dispatchEvent(new Event("brigadier-onboarding-complete"));
  };
  const next = useCallback(async () => {
    if (stage !== "welcome" || saving) return;
    if (replay && prefs?.completed) {
      void leave();
      return;
    }
    setSaving(true);
    setError("");
    try {
      await launchApi.seen();
      setStage("name");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [stage, saving, replay, prefs?.completed, leave]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        stage === "welcome" &&
        !error &&
        !e.repeat &&
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !(
          e.target instanceof Element &&
          e.target.closest("button, input, textarea, [contenteditable]")
        )
      ) {
        e.preventDefault();
        void next();
      }
      if (e.key === "Escape" && stage === "cinematic") {
        e.preventDefault();
        setStage("welcome");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [stage, error, next]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = await launchApi.complete(name);
      setPrefs((p) => ({ ...saved, desktopReveal: p?.desktopReveal ?? false }));
      setName(saved.name);
      setStage("greeting");
    } catch (e) {
      setFormError(errorMessage(e));
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  };
  const showApp =
    ready &&
    !!prefs &&
    (prefs.completed ||
      stage === "greeting" ||
      stage === "leaving" ||
      stage === "done");
  const nativeReveal = !!prefs?.desktopReveal && !replay;
  const scene = (stage === "cinematic" || stage === "welcome") && !reduced;
  return (
    <>
      {showApp && (
        <div
          className="launch-app"
          style={{
            visibility:
              active && stage !== "settling" && stage !== "revealing"
                ? "hidden"
                : undefined,
          }}
          inert={active || !!error}
          aria-hidden={active || !!error}
        >
          <Suspense
            fallback={<div className="launch-loading">Opening workspace…</div>}
          >
            <Workspace onReady={workspaceReady} />
          </Suspense>
        </div>
      )}
      {(active || !ready || !prefs || !!error) && (
        <section
          className={`launch ${nativeReveal ? "launch-desktop" : ""} ${reduced ? "launch-reduced" : ""} ${transitioning ? `launch-${stage}` : ""}`}
          aria-label="Welcome to Brigadier"
          data-stage={stage}
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.animationName === "workspace-reveal" &&
              stage === "revealing"
            )
              completeTransition();
          }}
        >
          {(stage === "greeting" || transitioning) && (
            <div
              className="launch-surface"
              style={
                nativeReveal
                  ? { width: cardSize.width, height: cardSize.height }
                  : undefined
              }
            />
          )}
          {prefs &&
            stage !== "handoff" &&
            stage !== "settling" &&
            stage !== "revealing" && (
              <CosmicField
                start={start}
                reveal={stage === "cinematic"}
                reduced={reduced}
                desktopReveal={nativeReveal}
              />
            )}
          <div
            className="launch-window"
            onAnimationEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.animationName === "launch-depart" &&
                stage === "leaving"
              )
                setStage("handoff");
            }}
          >
            {scene && (
              <div className="launch-mark" aria-hidden="true">
                <BrandMark />
              </div>
            )}
            {(stage === "cinematic" || stage === "welcome") && (
              <div
                className={`launch-welcome ${stage === "welcome" ? "launch-interactive" : ""}`}
              >
                <h1
                  ref={heading}
                  tabIndex={-1}
                  className="welcome-headline"
                  aria-label="Your next idea starts here."
                >
                  <span aria-hidden="true">
                    <span style={{ animationDelay: "6.45s" }}>Your</span>{" "}
                    <span style={{ animationDelay: "6.68s" }}>next</span>{" "}
                    <span style={{ animationDelay: "6.91s" }}>idea</span>
                  </span>
                  <span aria-hidden="true">
                    <span style={{ animationDelay: "7.14s" }}>starts</span>{" "}
                    <span style={{ animationDelay: "7.37s" }}>here.</span>
                  </span>
                </h1>
                <div
                  className="welcome-action"
                  onAnimationEnd={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      event.animationName === "welcome-button-reveal"
                    ) {
                      setStage((current) =>
                        current === "cinematic" ? "welcome" : current,
                      );
                    }
                  }}
                >
                  <button
                    className="welcome-next welcome-continue"
                    aria-keyshortcuts="Enter"
                    aria-label={replay ? "Return to workspace" : "Continue"}
                    disabled={
                      stage !== "welcome" || saving || (replay && !appMounted)
                    }
                    onClick={() => void next()}
                  >
                    <span>Continue</span>
                    <ArrowRightIcon aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
            {stage === "name" && (
              <form className="welcome-name" onSubmit={submit} noValidate>
                <h1>What should we call you?</h1>
                <p>Make yourself at home.</p>
                <label className="sr-only" htmlFor="welcome-name">
                  Your name
                </label>
                <input
                  id="welcome-name"
                  ref={input}
                  autoComplete="given-name"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setFormError("");
                  }}
                  required
                  maxLength={200}
                  aria-invalid={!!formError}
                  aria-describedby={
                    formError ? "welcome-name-error" : undefined
                  }
                  disabled={saving}
                />
                {formError && (
                  <p
                    id="welcome-name-error"
                    className="welcome-error"
                    role="alert"
                  >
                    {formError}
                  </p>
                )}
                <button
                  className="welcome-continue"
                  disabled={saving || !name.trim()}
                >
                  {saving ? "Saving…" : "Continue"}
                  <ArrowRightIcon aria-hidden="true" />
                </button>
              </form>
            )}
            {(stage === "greeting" || transitioning) && !replay && (
              <div className="welcome-greeting" role="status">
                <h1>Welcome, {name}.</h1>
                {!ready && <p>Opening your workspace…</p>}
              </div>
            )}
            {(!prefs || !ready) && !active && !error && (
              <div className="launch-loading">
                <BrandMark />
                <p>Opening Brigadier…</p>
              </div>
            )}
          </div>
          {error && (
            <div className="launch-error" role="alert">
              <h2>Brigadier couldn’t open</h2>
              <p>{error}</p>
              <button
                className="welcome-continue"
                onClick={() => {
                  setError("");
                  if (prefs?.completed && stage === "greeting") void leave();
                  else {
                    setStage("loading");
                    setAttempt((n) => n + 1);
                  }
                }}
              >
                Try again
              </button>
              <button
                className="launch-restart"
                onClick={() => void launchApi.restart()}
              >
                Restart app
              </button>
            </div>
          )}
        </section>
      )}
      {returnCue && ready && stage === "done" && (
        <div className="return-motif" aria-hidden="true">
          <BrandMark />
        </div>
      )}
    </>
  );
}
