import { useEffect } from "react";

export function useMusic(track: string | null, enabled: boolean) {
  useEffect(() => {
    if (!track || !enabled) return;
    // An HTMLAudioElement registers the intro as a track in macOS Now Playing.
    // Web Audio plays this UI sound without creating a media-player session.
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = 0.6;
    gain.connect(context.destination);
    const request = new AbortController();
    let live = true;
    let source: AudioBufferSourceNode | undefined;
    let buffer: AudioBuffer | undefined;
    let fade: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const removeRetry = () => {
      window.removeEventListener("pointerdown", play);
      window.removeEventListener("keydown", play);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      removeRetry();
      clearTimeout(fade);
      if (source) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      gain.disconnect();
      void context.close().catch(() => {});
    };
    // Resume inside the gesture handler so blocked autoplay can recover.
    const play = () => {
      if (!live || closed || source) return;
      void context.resume().then(() => {
        if (!live || closed || source || !buffer || context.state !== "running")
          return;
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = close;
        source.start();
        removeRetry();
      }).catch(() => {});
    };
    window.addEventListener("pointerdown", play);
    window.addEventListener("keydown", play);
    play();
    void fetch(track, { signal: request.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load welcome sound");
        return response.arrayBuffer();
      })
      .then((data) => {
        if (live) return context.decodeAudioData(data);
      })
      .then((decoded) => {
        if (!live || closed || !decoded) return;
        buffer = decoded;
        play();
      })
      .catch(close);

    return () => {
      live = false;
      request.abort();
      removeRetry();
      if (closed) return;
      if (!source || context.state !== "running") {
        close();
        return;
      }
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.6);
      fade = setTimeout(close, 600);
    };
  }, [track, enabled]);
}
