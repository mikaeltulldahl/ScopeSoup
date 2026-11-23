// Hash routing: #/ (overview), #/queue, #/items?<filters> (the list), #/settings, #/settings/stop, #/history, #/item/<refKey>.

import { useEffect, useRef, useState } from "preact/hooks";

export type Route = { view: "overview" } | { view: "queue" } | { view: "items"; query: string } | { view: "settings" } | { view: "stop" } | { view: "history" } | { view: "usage" } | { view: "item"; key: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "items" || path.startsWith("items?")) return { view: "items", query: path.slice(6) };
  if (path === "queue") return { view: "queue" };
  if (path === "settings") return { view: "settings" };
  if (path === "settings/stop") return { view: "stop" };
  if (path === "history") return { view: "history" };
  if (path === "usage") return { view: "usage" };
  if (path.startsWith("item/")) {
    try {
      return { view: "item", key: decodeURIComponent(path.slice(5)) };
    } catch {
      return { view: "overview" };
    }
  }
  return { view: "overview" };
}

export const itemHref = (key: string) => `#/item/${encodeURIComponent(key)}`;

/** The route and, when an item is open over a view, the hash of that view (what closing returns to). */
export interface Routed {
  route: Route;
  /** The view shown behind the item dialog; the overview when an item was opened directly. */
  below: Exclude<Route, { view: "item" }>;
  /** Hash to go back to when the dialog closes. */
  belowHash: string;
}

export function useRoute(): Routed {
  const [hash, setHash] = useState(location.hash);
  const under = useRef(parseRoute(location.hash).view === "item" ? "#/" : location.hash);
  const route = parseRoute(hash);
  if (route.view !== "item") under.current = hash;
  useEffect(() => {
    const onChange = (event: HashChangeEvent) => {
      const before = new URL(event.oldURL).hash;
      // The dialog opens and closes over the view, which stays where it is; any other move starts at the top.
      if (parseRoute(before).view !== "item" && parseRoute(location.hash).view !== "item") window.scrollTo(0, 0);
      // The view the dialog opens over may have changed its own hash quietly (the list's filters), so take it from the URL left.
      if (parseRoute(before).view !== "item" && parseRoute(location.hash).view === "item") under.current = before || "#/";
      setHash(location.hash);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { route, below: parseRoute(under.current) as Routed["below"], belowHash: under.current };
}
