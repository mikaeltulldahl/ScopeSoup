/** A count with its noun, said properly: "1 question", "2 questions". The noun may have words before it ("open child item"). */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
