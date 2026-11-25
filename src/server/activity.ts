// `GET /api/activity`: reads the Items, sessions, batches and the store's events the timeline needs, and the settings'
// log, then builds the rows with core (src/core/activity.ts).

import { ACTIVITY_EVENTS, buildActivity, type SettingsSave } from "../core/activity.ts";
import type { ActivityView } from "../core/views.ts";
import type { Batch, Change, Session, WorkItem } from "../model/types.ts";
import type { Store } from "../store/store.ts";

/** The store's events read at most: the newest of the kinds the timeline shows. */
const MAX_EVENTS = 5000;

export function activityView(store: Store, settings: SettingsSave[], now: Date): ActivityView {
  return buildActivity(
    {
      works: store.list<WorkItem>("work"),
      changes: store.list<Change>("change"),
      sessions: store.list<Session>("session"),
      batches: store.list<Batch>("batch"),
      events: store.eventsOfKinds(ACTIVITY_EVENTS, MAX_EVENTS),
      settings,
    },
    now.toISOString(),
  );
}
