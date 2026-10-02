import { useEffect } from "preact/hooks";

/**
 * Mobile chat: the on-screen keyboard never resizes the layout viewport on iOS.
 * It *pans* it — `visualViewport.offsetTop` becomes > 0 and the window scrolls —
 * so a shell sized to the layout viewport, or to `dvh`, ends up with the
 * composer at the top of the visible area and the transcript above it, off
 * screen (the mobile-chat-layout regression, operator 2026-09-27).
 *
 * The shell is pinned to `position: fixed` (below 900px, in shell.css) and this
 * module keeps it on the *visual* viewport: `--cp-viewport-height` is
 * `visualViewport.height` and `--cp-viewport-offset` is the pan that moves it
 * down past the top. `resize` covers the keyboard opening and closing, `scroll`
 * the pan, and focus on a text field resets the page scroll so the window
 * itself never drifts.
 */

/** The slice of `window.visualViewport` this depends on: a real one, or a stub. */
export interface VisualViewportLike {
	readonly height: number;
	readonly offsetTop: number;
	addEventListener(type: "resize" | "scroll", listener: () => void): void;
	removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

export interface ViewportPorts {
	readonly root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } };
	readonly viewport: VisualViewportLike;
	/** The window's own pan; zeroed, never read back. */
	scrollTo(x: number, y: number): void;
	/** Runs after the shell is repositioned, so the transcript can follow the newest entry. */
	onFit?: () => void;
}

/** The shell's height, in px, on the visual viewport. */
export const VIEWPORT_HEIGHT = "--cp-viewport-height";
/** How far the visual viewport is panned down, in px; the shell's `translateY`. */
export const VIEWPORT_OFFSET = "--cp-viewport-offset";

/**
 * Keep the shell on the visible slice of the page, and stop the page itself
 * from panning under it. The window scroll is read once, before it is reset, so
 * the offset is the keyboard pan and not the (about to be undone) page scroll.
 */
export function fitViewport(ports: ViewportPorts): void {
	const { root, viewport } = ports;
	ports.scrollTo(0, 0);
	const offset = Math.max(0, Math.round(viewport.offsetTop - window.scrollY));
	root.style.setProperty(VIEWPORT_HEIGHT, `${Math.round(viewport.height)}px`);
	root.style.setProperty(VIEWPORT_OFFSET, `${offset}px`);
	ports.onFit?.();
}

export function clearViewport(root: ViewportPorts["root"]): void {
	root.style.removeProperty(VIEWPORT_HEIGHT);
	root.style.removeProperty(VIEWPORT_OFFSET);
}

/**
 * Wire `fitViewport` to the real visual viewport, its `resize` and `scroll`
 * events, and every text field gaining focus — the keyboard's pan can start
 * before its resize arrives. Without a `visualViewport` (older browsers, tests)
 * this is a no-op and the stylesheet's `100dvh` fallback holds.
 */
export function useViewportFit(onFit?: () => void): void {
	useEffect(() => {
		const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
		if (!viewport) return;
		const ports: ViewportPorts = { root: document.documentElement, viewport, scrollTo: (x, y) => window.scrollTo(x, y), ...(onFit ? { onFit } : {}) };
		const fit = () => fitViewport(ports);
		// The keyboard's pan can begin before its resize: a tapped field fits immediately.
		const field = (event: Event) => { if ((event.target as Element | null)?.closest?.("input, textarea")) fit(); };
		fit();
		viewport.addEventListener("resize", fit);
		viewport.addEventListener("scroll", fit);
		document.addEventListener("focusin", field);
		return () => { viewport.removeEventListener("resize", fit); viewport.removeEventListener("scroll", fit); document.removeEventListener("focusin", field); clearViewport(ports.root); };
	}, []);
}
