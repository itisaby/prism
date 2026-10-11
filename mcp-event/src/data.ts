// In-memory hackathon ops state (AI Engineer NYC hackathon). Seeded deterministically relative to process start;
// a ticker (`startSimulation`) makes it feel live: check-ins trickle in, help requests appear and age in real time.

export type Track = 'Agents' | 'DevTools' | 'Data';
export type ProjectStatus = 'idea' | 'building' | 'demo-ready';
export type HelpStatus = 'open' | 'assigned' | 'resolved';
export type TaskStatus = 'todo' | 'doing' | 'done';
export type Tone = 'ok' | 'warn' | 'bad';

export interface Team { id: string; name: string; track: Track; table: number; members: string[]; projectStatus: ProjectStatus }
export interface Mentor { id: string; name: string; skills: string[]; currentRequestId?: number }
export interface HelpRequest {
  id: number; teamId: string; topic: string; skill: string; createdAt: number;
  status: HelpStatus; mentorId?: string; assignedAt?: number; resolvedAt?: number;
}
export interface Task { id: string; title: string; area: string; status: TaskStatus; owner?: string; version: number; updatedAt: number }
export interface JudgingSlot { teamId: string; judge: string; slot: string; room: string; status: 'scheduled' | 'in-progress' | 'done' }
export interface ScheduleItem { time: string; title: string; room: string }

export const EXPECTED_ATTENDANCE = 420;
export const DOORS_HOUR = 8;

export class UserError extends Error {}

// ---------------------------------------------------------------- deterministic PRNG
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- state
interface State {
  teams: Team[];
  mentors: Mentor[];
  help: HelpRequest[];
  checkins: Map<number, number>; // hour of day (0-23) -> count
  tasks: Task[];
  judging: JudgingSlot[];
  schedule: ScheduleItem[];
  nextHelpId: number;
  nextTaskId: number;
  seededAt: number;
  rng: () => number;
}

export let state: State = seed();

const MIN = 60_000;

function seed(now = Date.now()): State {
  const rng = mulberry32(20261011);

  const teams: Team[] = [
    { id: 'trailmix', name: 'TrailMix', track: 'Agents', table: 1, members: ['Ana Ruiz', 'Ben Cho', 'Kofi Mensah'], projectStatus: 'building' },
    { id: 'promptly', name: 'Promptly', track: 'DevTools', table: 2, members: ['Lena Park', 'Omar Haddad'], projectStatus: 'demo-ready' },
    { id: 'vectorvault', name: 'VectorVault', track: 'Data', table: 3, members: ['Ivy Chen', 'Raj Patel', 'Sam Okoye', 'Mia Rossi'], projectStatus: 'building' },
    { id: 'lighthouse', name: 'Lighthouse', track: 'Agents', table: 4, members: ['Noah Kim', 'Zara Ali'], projectStatus: 'idea' },
    { id: 'kernel-panic', name: 'Kernel Panic', track: 'DevTools', table: 5, members: ['Eli Novak', 'Grace Wu', 'Tomás Silva'], projectStatus: 'building' },
    { id: 'synapse', name: 'Synapse', track: 'Agents', table: 6, members: ['Hana Sato', 'Leo Brooks', 'Nia Johnson'], projectStatus: 'demo-ready' },
    { id: 'dataduck', name: 'DataDuck', track: 'Data', table: 7, members: ['Owen Price', 'Ruby Flores'], projectStatus: 'building' },
    { id: 'fieldnotes', name: 'Fieldnotes', track: 'Data', table: 8, members: ['Maya Singh', 'Jonah Weiss', 'Ade Bello'], projectStatus: 'building' },
    { id: 'patchwork', name: 'Patchwork', track: 'DevTools', table: 9, members: ['Chloe Martin', 'Victor Lin'], projectStatus: 'idea' },
    { id: 'relay', name: 'Relay', track: 'Agents', table: 10, members: ['Iris Moreau', 'Kai Nakamura', 'Dev Shah'], projectStatus: 'building' },
    { id: 'tidepool', name: 'Tidepool', track: 'Data', table: 11, members: ['Elena Petrova', 'Marcus Hill'], projectStatus: 'demo-ready' },
    { id: 'bytesmith', name: 'Bytesmith', track: 'DevTools', table: 12, members: ['Yusuf Kaya', 'Abby Turner', 'Finn O\'Neil'], projectStatus: 'building' },
  ];

  const mentors: Mentor[] = [
    { id: 'priya', name: 'Priya Raman', skills: ['RAG', 'Evals', 'Python'] },
    { id: 'marcus', name: 'Marcus Lee', skills: ['Kubernetes', 'Infra', 'Go'] },
    { id: 'sofia', name: 'Sofia Alvarez', skills: ['Frontend', 'React', 'Design'] },
    { id: 'kenji', name: 'Kenji Watanabe', skills: ['Agents', 'MCP', 'TypeScript'] },
    { id: 'amara', name: 'Amara Okafor', skills: ['Data', 'SQL', 'Pipelines'] },
    { id: 'diego', name: 'Diego Santos', skills: ['MCP', 'Frontend', 'TypeScript'] },
  ];

  // Exactly one request waits ~7 min at seed (tone warn); one fresh one (ok). Matching mentors (priya, sofia) are free.
  const help: HelpRequest[] = [
    { id: 1, teamId: 'promptly', topic: 'Streaming tokens to the UI', skill: 'Frontend', createdAt: now - 150 * MIN, status: 'resolved', mentorId: 'sofia', assignedAt: now - 146 * MIN, resolvedAt: now - 130 * MIN },
    { id: 2, teamId: 'vectorvault', topic: 'pgvector index too slow', skill: 'Data', createdAt: now - 120 * MIN, status: 'resolved', mentorId: 'amara', assignedAt: now - 117 * MIN, resolvedAt: now - 95 * MIN },
    { id: 3, teamId: 'synapse', topic: 'Tool-call loop never terminates', skill: 'Agents', createdAt: now - 90 * MIN, status: 'resolved', mentorId: 'kenji', assignedAt: now - 84 * MIN, resolvedAt: now - 70 * MIN },
    { id: 4, teamId: 'tidepool', topic: 'Eval set for retrieval quality', skill: 'Evals', createdAt: now - 65 * MIN, status: 'resolved', mentorId: 'priya', assignedAt: now - 61 * MIN, resolvedAt: now - 40 * MIN },
    { id: 5, teamId: 'kernel-panic', topic: 'Deploying to the sponsor cluster', skill: 'Kubernetes', createdAt: now - 22 * MIN, status: 'assigned', mentorId: 'marcus', assignedAt: now - 18 * MIN },
    { id: 6, teamId: 'relay', topic: 'MCP server auth with bearer tokens', skill: 'MCP', createdAt: now - 16 * MIN, status: 'assigned', mentorId: 'kenji', assignedAt: now - 12 * MIN },
    { id: 7, teamId: 'trailmix', topic: 'RAG eval', skill: 'RAG', createdAt: now - 7 * MIN - 10_000, status: 'open' },
    { id: 8, teamId: 'patchwork', topic: 'React state for a live diff view', skill: 'Frontend', createdAt: now - 2 * MIN, status: 'open' },
  ];
  for (const r of help) if (r.status === 'assigned') mentors.find(m => m.id === r.mentorId)!.currentRequestId = r.id;

  // Check-ins: doors at 08:00; front-loaded arrival curve up to the current hour, ~80% of expected so far.
  const hourNow = new Date(now).getHours();
  const first = hourNow >= DOORS_HOUR + 2 ? DOORS_HOUR : Math.max(0, hourNow - 5);
  const hours: number[] = [];
  for (let h = first; h <= hourNow; h++) hours.push(h);
  const curve = [0.36, 0.3, 0.14, 0.08, 0.05, 0.03, 0.02, 0.01, 0.01];
  const weights = hours.map((_, i) => curve[i] ?? 0.005);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const target = 336;
  const checkins = new Map<number, number>();
  let assigned = 0;
  hours.forEach((h, i) => {
    const n = i === hours.length - 1 ? target - assigned : Math.round((target * weights[i]) / wsum * (0.92 + rng() * 0.16));
    checkins.set(h, Math.max(0, n));
    assigned += Math.max(0, n);
  });

  const tasks: Task[] = [
    { id: 'T1', title: 'Restock coffee at Station B', area: 'Food', status: 'todo', version: 1, updatedAt: now - 9 * MIN },
    { id: 'T2', title: 'Swap dead handheld mic on Main Stage', area: 'AV', status: 'doing', owner: 'Jess', version: 3, updatedAt: now - 14 * MIN },
    { id: 'T3', title: 'Print 40 judging rubrics', area: 'Judging', status: 'todo', version: 1, updatedAt: now - 30 * MIN },
    { id: 'T4', title: 'Relieve badge desk (12:00 shift)', area: 'Registration', status: 'done', owner: 'Luis', version: 4, updatedAt: now - 45 * MIN },
    { id: 'T5', title: 'Fix flaky Wi-Fi AP in Room 3B', area: 'Venue', status: 'doing', owner: 'Ming', version: 2, updatedAt: now - 20 * MIN },
    { id: 'T6', title: 'Set up demo-stage countdown timer', area: 'AV', status: 'todo', version: 1, updatedAt: now - 25 * MIN },
    { id: 'T7', title: 'Collect dietary counts for dinner', area: 'Food', status: 'done', owner: 'Jess', version: 2, updatedAt: now - 60 * MIN },
    { id: 'T8', title: 'Post judging schedule in #announcements', area: 'Comms', status: 'todo', version: 1, updatedAt: now - 5 * MIN },
  ];

  const judges = [{ judge: 'Judge Chen', room: 'Judging A' }, { judge: 'Judge Patel', room: 'Judging B' }, { judge: 'Judge Rivera', room: 'Judging C' }];
  const judging: JudgingSlot[] = teams.map((t, i) => {
    const j = judges[i % 3];
    const minutes = 15 * 60 + Math.floor(i / 3) * 10;
    return { teamId: t.id, judge: j.judge, room: j.room, slot: hhmm(minutes), status: 'scheduled' };
  });

  const schedule: ScheduleItem[] = [
    { time: '08:00', title: 'Doors open & check-in', room: 'Lobby' },
    { time: '09:00', title: 'Kickoff keynote', room: 'Main Stage' },
    { time: '09:45', title: 'Hacking begins', room: 'Hack Floor' },
    { time: '12:00', title: 'Lunch', room: 'Atrium' },
    { time: '13:00', title: 'Workshop: MCP servers in production', room: 'Room 3B' },
    { time: '14:00', title: 'Workshop: Evals that actually matter', room: 'Room 3A' },
    { time: '15:00', title: 'Hacking ends, judging rounds', room: 'Judging A–C' },
    { time: '17:00', title: 'Finalist demos', room: 'Main Stage' },
    { time: '18:00', title: 'Awards & closing', room: 'Main Stage' },
  ];

  return { teams, mentors, help, checkins, tasks, judging, schedule, nextHelpId: 9, nextTaskId: 9, seededAt: now, rng };
}

export function reset() { state = seed(); }

// ---------------------------------------------------------------- helpers
export const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const firstName = (m: Mentor) => m.name.split(' ')[0];
export const teamOf = (id: string) => state.teams.find(t => t.id === id);
export const mentorOf = (id: string | undefined) => (id ? state.mentors.find(m => m.id === id) : undefined);
export const mentorAvailable = (m: Mentor) => m.currentRequestId === undefined;

export function waitingMinutes(r: HelpRequest, now = Date.now()): number {
  const end = r.assignedAt ?? r.resolvedAt ?? now;
  return Math.max(0, Math.floor((end - r.createdAt) / MIN));
}

export function helpTone(r: HelpRequest, now = Date.now()): Tone {
  if (r.status !== 'open') return 'ok';
  const w = waitingMinutes(r, now);
  return w > 10 ? 'bad' : w > 5 ? 'warn' : 'ok';
}

export const totalCheckedIn = () => [...state.checkins.values()].reduce((a, b) => a + b, 0);

function addCheckins(n: number, now = Date.now()) {
  const h = new Date(now).getHours();
  state.checkins.set(h, (state.checkins.get(h) ?? 0) + n);
}

function newHelpRequest(teamId: string, topic: string, skill: string, createdAt: number): HelpRequest {
  const r: HelpRequest = { id: state.nextHelpId++, teamId, topic, skill, createdAt, status: 'open' };
  state.help.push(r);
  return r;
}

// ---------------------------------------------------------------- mutations (validate first; apply only when !dryRun)
export interface Outcome { changes: string[]; [k: string]: unknown }

function findRequest(id: number): HelpRequest {
  const r = state.help.find(x => x.id === id);
  if (!r) throw new UserError(`Help request #${id} does not exist. Open requests: ${state.help.filter(x => x.status === 'open').map(x => `#${x.id}`).join(', ') || 'none'}.`);
  return r;
}
function findTask(id: string): Task {
  const t = state.tasks.find(x => x.id.toLowerCase() === id.toLowerCase());
  if (!t) throw new UserError(`Task ${id} does not exist. Known tasks: ${state.tasks.map(x => x.id).join(', ')}.`);
  return t;
}
function checkVersion(t: Task, expected?: number) {
  if (expected !== undefined && expected !== t.version) {
    throw new UserError(`Conflict: task ${t.id} is at version ${t.version}, not ${expected} (someone changed it: status ${t.status}${t.owner ? `, owner ${t.owner}` : ''}). Re-read the task and retry. Nothing was changed.`);
  }
}
const describeRequest = (r: HelpRequest) => `help request #${r.id} (${teamOf(r.teamId)?.name ?? r.teamId}, ${r.topic})`;

export function assignMentor(requestId: number, mentorId: string, dryRun: boolean, now = Date.now()): Outcome {
  const r = findRequest(requestId);
  const m = state.mentors.find(x => x.id === mentorId.toLowerCase() || x.name.toLowerCase() === mentorId.toLowerCase() || firstName(x).toLowerCase() === mentorId.toLowerCase());
  if (!m) throw new UserError(`Mentor "${mentorId}" does not exist. Mentors: ${state.mentors.map(x => x.id).join(', ')}.`);
  if (r.status !== 'open') {
    const who = mentorOf(r.mentorId);
    throw new UserError(`Help request #${r.id} is ${r.status}${who ? ` (${firstName(who)})` : ''}, not open, so it cannot be assigned. Nothing was changed.`);
  }
  if (!mentorAvailable(m)) {
    const cur = state.help.find(x => x.id === m.currentRequestId)!;
    const alts = state.mentors.filter(x => mentorAvailable(x) && x.skills.includes(r.skill)).map(firstName);
    throw new UserError(`Conflict: ${firstName(m)} is busy with ${describeRequest(cur)}. ${alts.length ? `Available mentors with ${r.skill}: ${alts.join(', ')}.` : `No available mentor has ${r.skill} right now.`} Nothing was changed.`);
  }
  const changes = [
    `${firstName(m)} → ${describeRequest(r)}`,
    `${firstName(m)} becomes busy`,
    `request #${r.id} open → assigned after waiting ${waitingMinutes(r, now)} min`,
  ];
  if (!m.skills.includes(r.skill)) changes.push(`note: ${firstName(m)} does not list ${r.skill} (skills: ${m.skills.join(', ')})`);
  if (!dryRun) {
    r.status = 'assigned'; r.mentorId = m.id; r.assignedAt = now;
    m.currentRequestId = r.id;
  }
  return { changes, requestId: r.id, mentorId: m.id };
}

export function resolveHelpRequest(requestId: number, dryRun: boolean, now = Date.now()): Outcome {
  const r = findRequest(requestId);
  if (r.status === 'resolved') throw new UserError(`Help request #${r.id} is already resolved. Nothing was changed.`);
  const m = mentorOf(r.mentorId);
  const changes = [`${describeRequest(r)} ${r.status} → resolved`];
  if (m) changes.push(`${firstName(m)} becomes available`);
  else changes.push(`resolved without a mentor after waiting ${waitingMinutes(r, now)} min`);
  if (!dryRun) {
    if (r.status === 'open') r.assignedAt = now; // freeze waiting time
    r.status = 'resolved'; r.resolvedAt = now;
    if (m && m.currentRequestId === r.id) m.currentRequestId = undefined;
  }
  return { changes, requestId: r.id };
}

export function claimTask(taskId: string, owner: string, expectedVersion: number | undefined, dryRun: boolean, now = Date.now()): Outcome {
  const t = findTask(taskId);
  checkVersion(t, expectedVersion);
  if (t.status === 'done') throw new UserError(`Task ${t.id} ("${t.title}") is already done. Nothing was changed.`);
  if (t.owner && t.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new UserError(`Conflict: task ${t.id} ("${t.title}") is already claimed by ${t.owner}. Nothing was changed.`);
  }
  const changes: string[] = [];
  if (!t.owner) changes.push(`${owner} claims task ${t.id} ("${t.title}")`);
  if (t.status === 'todo') changes.push(`status todo → doing`);
  if (!changes.length) changes.push(`no change: ${t.owner} already owns task ${t.id}`);
  else changes.push(`version ${t.version} → ${t.version + 1}`);
  if (!dryRun && changes.length > 1) {
    t.owner = owner; t.status = 'doing'; t.version++; t.updatedAt = now;
  }
  return { changes, taskId: t.id, version: t.version };
}

export function updateTaskStatus(taskId: string, status: TaskStatus, expectedVersion: number | undefined, dryRun: boolean, now = Date.now()): Outcome {
  const t = findTask(taskId);
  checkVersion(t, expectedVersion);
  if (t.status === status) return { changes: [`no change: task ${t.id} is already ${status}`], taskId: t.id, version: t.version };
  const changes = [`task ${t.id} ("${t.title}") ${t.status} → ${status}`];
  if (status === 'todo' && t.owner) changes.push(`${t.owner} is unassigned`);
  changes.push(`version ${t.version} → ${t.version + 1}`);
  if (!dryRun) {
    t.status = status; t.version++; t.updatedAt = now;
    if (status === 'todo') t.owner = undefined;
  }
  return { changes, taskId: t.id, version: t.version };
}

export function createTask(title: string, area: string, dryRun: boolean, now = Date.now()): Outcome {
  const clean = title.trim();
  if (!clean) throw new UserError('Task title must not be empty.');
  const id = `T${state.nextTaskId}`;
  const changes = [`new task ${id} "${clean}" in ${area} (todo, unclaimed)`];
  if (!dryRun) {
    state.tasks.push({ id, title: clean, area, status: 'todo', version: 1, updatedAt: now });
    state.nextTaskId++;
  }
  return { changes, taskId: id };
}

// ---------------------------------------------------------------- demo spike: 3 teams stuck on the same skill
const SPIKE_TOPICS = ['MCP auth handshake returns 401', 'MCP tool outputSchema rejected', 'Streamable HTTP 406 from MCP server'];

export function spike(now = Date.now()): HelpRequest[] {
  const busy = new Set(state.help.filter(r => r.status !== 'resolved').map(r => r.teamId));
  const pool = [...state.teams.filter(t => !busy.has(t.id)), ...state.teams.filter(t => busy.has(t.id))];
  return [12, 10, 8].map((age, i) => newHelpRequest(pool[i].id, SPIKE_TOPICS[i], 'MCP', now - age * MIN - 15_000));
}

// ---------------------------------------------------------------- live ticker
const TICK_TOPICS: [string, string][] = [
  ['Agent forgets context between turns', 'Agents'], ['Chunking strategy for long PDFs', 'RAG'], ['Docker build fails on ARM', 'Infra'],
  ['Join explodes row counts', 'SQL'], ['Tailwind classes not applying', 'Frontend'], ['MCP client cannot list tools', 'MCP'],
  ['Measuring hallucination rate', 'Evals'], ['Rate limits during demo', 'Infra'], ['Streaming JSON parse errors', 'TypeScript'],
];

export function tick(now = Date.now()) {
  const rng = state.rng;
  // check-ins: 1-2 most ticks, slowing to a trickle near expected attendance
  const total = totalCheckedIn();
  const p = rng();
  if (total < EXPECTED_ATTENDANCE * 0.96) { if (p < 0.55) addCheckins(1, now); else if (p < 0.8) addCheckins(2, now); }
  else if (p < 0.05) addCheckins(1, now);

  // occasionally a new help request (cap the open backlog from the ticker at 6)
  const open = state.help.filter(r => r.status === 'open').length;
  if (open < 6 && rng() < 0.08) {
    const busy = new Set(state.help.filter(r => r.status !== 'resolved').map(r => r.teamId));
    const free = state.teams.filter(t => !busy.has(t.id));
    if (free.length) {
      const team = free[Math.floor(rng() * free.length)];
      const [topic, skill] = TICK_TOPICS[Math.floor(rng() * TICK_TOPICS.length)];
      newHelpRequest(team.id, topic, skill, now);
    }
  }

  // mentors finish long-running sessions (assigned > 15 min ago)
  if (rng() < 0.05) {
    const done = state.help.find(r => r.status === 'assigned' && now - (r.assignedAt ?? now) > 15 * MIN);
    if (done) resolveHelpRequest(done.id, false, now);
  }

  // teams make progress
  if (rng() < 0.03) {
    const t = state.teams[Math.floor(rng() * state.teams.length)];
    if (t.projectStatus === 'idea') t.projectStatus = 'building';
    else if (t.projectStatus === 'building' && rng() < 0.5) t.projectStatus = 'demo-ready';
  }
}

let timer: NodeJS.Timeout | undefined;
export function startSimulation(everyMs = 10_000) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(), everyMs);
}
