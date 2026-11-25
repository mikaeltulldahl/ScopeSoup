// Who is at the board, picked at the top. The people Scope Soup knows (holds, log lines, answers) are offered, and a new
// name can be typed. The pick stays in this browser (src/person.ts); every answer, claim and release records it.

import { useState } from "preact/hooks";
import { usePerson } from "./api.ts";
import { cleanName, PERSON_MAX, pickerOptions, setPerson } from "./person.ts";

/** Not a name: a cleaned name never starts with a space. */
const NEW = " new";

export function PersonPicker({ known, names }: { known: readonly string[]; names?: Readonly<Record<string, string>> }) {
  const person = usePerson();
  const options = pickerOptions(known, person, names);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");

  if (adding || options.length === 0) {
    const name = cleanName(typed);
    return (
      <form
        class="person-picker"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name) return;
          setPerson(name);
          setTyped("");
          setAdding(false);
        }}
      >
        <label for="person-name">You are</label>
        <input id="person-name" type="text" autocomplete="name" maxLength={PERSON_MAX} placeholder="your name" value={typed} onInput={(event) => setTyped(event.currentTarget.value)} />
        <button type="submit" disabled={!name}>Add</button>
        {options.length > 0 && (
          <button type="button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        )}
      </form>
    );
  }
  return (
    <div class="person-picker">
      <label for="person-select">You are</label>
      <select
        id="person-select"
        value={person}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === NEW) {
            event.currentTarget.value = person;
            setAdding(true);
          } else setPerson(value);
        }}
      >
        {!person && <option value="">pick who you are</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value={NEW}>Someone new…</option>
      </select>
    </div>
  );
}
