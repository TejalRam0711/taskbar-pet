// What Claude is waiting on you for, as "<session> <tool>". Hooks in Claude Code's settings tell the pet (lib.rs).
// The tool matters: during a wait, other work keeps finishing (subagents, parallel tool calls, other sessions),
// and that mustn't end it. A wait with no tool is a notification; `asked` is a question at the end of a reply.
const ASKED = 'asked';

// up: it's waiting. down: that tool finished. stop: the turn is over, so only its closing question still waits.
// clear: you replied, or the session ended. Returns true if this session has only now started waiting.
export function applySignal(waiting: Set<string>, [kind, session, tool = '']: string[]) {
  const mine = [...waiting].filter((key) => key.startsWith(`${session} `));
  if (kind === 'up') {
    waiting.add(`${session} ${tool}`);
    return mine.length === 0;
  }
  for (const key of mine) {
    const t = key.slice(session.length + 1);
    if (kind === 'clear' || (kind === 'stop' ? t !== ASKED : t === tool || t === '')) waiting.delete(key);
  }
  return false;
}
