// MCP tools over the in-memory hackathon ops state. Every tool returns structuredContent (+ the same JSON as text)
// and declares an outputSchema. Write tools accept dryRun and return { ok, dryRun, changes, summary }.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  assignMentor, claimTask, createTask, DOORS_HOUR, EXPECTED_ATTENDANCE, firstName, helpTone, hhmm, mentorAvailable, mentorOf,
  resolveHelpRequest, state, teamOf, totalCheckedIn, updateTaskStatus, UserError, waitingMinutes,
  type HelpRequest, type Outcome, type Tone,
} from './data.js';

// ---------------------------------------------------------------- plumbing
type Json = Record<string, unknown>;
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Json; isError?: boolean };

const ok = (value: Json): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const tone = z.enum(['ok', 'warn', 'bad']);
const dryRunArg = z.boolean().optional().describe('Preview only: validates and returns the changes that would happen; nothing is changed. Default false.');
const expectedVersionArg = z.number().int().optional().describe('Optimistic concurrency: fail with a conflict if the task is no longer at this version.');
const writeResult = z.looseObject({ ok: z.boolean(), dryRun: z.boolean(), changes: z.array(z.string()), summary: z.string() });
const metricItem = z.looseObject({ label: z.string(), value: z.union([z.string(), z.number()]), hint: z.string().optional(), tone: tone.optional() });

let callSeq = 0;
function register<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; input: S; output: z.ZodType; write?: boolean; idempotent?: boolean },
  run: (args: z.infer<S>) => Json,
) {
  server.registerTool(name, {
    title: cfg.title,
    description: cfg.description,
    inputSchema: cfg.input,
    outputSchema: cfg.output,
    annotations: cfg.write ? { ...WRITE, idempotentHint: !!cfg.idempotent, title: cfg.title } : { ...READ, title: cfg.title },
  } as any, (async (args: z.infer<S>) => {
    const id = ++callSeq;
    try {
      const out = ok(run(args));
      console.log(`[tool #${id}] ${name} ${JSON.stringify(args)} ok`);
      return out;
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `Internal error in ${name}: ${(e as Error).message}`;
      console.log(`[tool #${id}] ${name} ${JSON.stringify(args)} error: ${msg}`);
      return fail(msg);
    }
  }) as any);
}

function writeOut(dryRun: boolean, o: Outcome): Json {
  return { ok: true, dryRun, ...o, summary: `${dryRun ? 'Dry run (nothing changed): ' : ''}${o.changes.join('; ')}` };
}

// ---------------------------------------------------------------- row views
function helpRow(r: HelpRequest, now: number) {
  const team = teamOf(r.teamId);
  const mentor = mentorOf(r.mentorId);
  const w = waitingMinutes(r, now);
  return {
    id: r.id,
    teamId: r.teamId,
    teamName: team?.name ?? r.teamId,
    table: team?.table ?? null,
    topic: r.topic,
    skill: r.skill,
    createdAt: new Date(r.createdAt).toISOString(),
    waitingMinutes: w,
    waiting: `${w} min`,
    status: r.status,
    mentorId: r.mentorId ?? null,
    mentorName: mentor?.name ?? null,
    availableMentors: r.status === 'open' ? state.mentors.filter(m => mentorAvailable(m) && m.skills.includes(r.skill)).map(m => m.id) : [],
    tone: helpTone(r, now),
  };
}

const statusTone: Record<string, Tone> = { idea: 'bad', building: 'warn', 'demo-ready': 'ok' };

// ---------------------------------------------------------------- tools
export function registerTools(server: McpServer) {
  register(server, 'event_overview', {
    title: 'Event overview',
    description: 'One-call health summary of the hackathon floor: attendance vs expected, open help requests, longest wait, teams demo-ready, mentors free, unclaimed volunteer tasks. `items` is ready for a MetricRow.',
    input: z.object({}),
    output: z.looseObject({
      at: z.string(), checkedIn: z.number(), expected: z.number(), openHelpRequests: z.number(), assignedHelpRequests: z.number(),
      longestWaitMinutes: z.number(), teamsDemoReady: z.number(), teams: z.number(), mentorsAvailable: z.number(), mentors: z.number(),
      tasksUnclaimed: z.number(), items: z.array(metricItem),
    }),
  }, () => {
    const now = Date.now();
    const checkedIn = totalCheckedIn();
    const open = state.help.filter(r => r.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
    const assigned = state.help.filter(r => r.status === 'assigned').length;
    const longest = open[0];
    const longestWait = longest ? waitingMinutes(longest, now) : 0;
    const waitTone: Tone = longestWait > 10 ? 'bad' : longestWait > 5 ? 'warn' : 'ok';
    const ready = state.teams.filter(t => t.projectStatus === 'demo-ready').length;
    const free = state.mentors.filter(mentorAvailable);
    const unclaimed = state.tasks.filter(t => t.status === 'todo' && !t.owner).length;
    const pct = Math.round((checkedIn / EXPECTED_ATTENDANCE) * 100);
    return {
      at: new Date(now).toISOString(),
      checkedIn, expected: EXPECTED_ATTENDANCE,
      openHelpRequests: open.length, assignedHelpRequests: assigned,
      longestWaitMinutes: longestWait,
      teamsDemoReady: ready, teams: state.teams.length,
      mentorsAvailable: free.length, mentors: state.mentors.length,
      tasksUnclaimed: unclaimed,
      items: [
        { label: 'Checked in', value: `${checkedIn} / ${EXPECTED_ATTENDANCE}`, hint: `${pct}% of expected`, tone: pct >= 75 ? 'ok' : 'warn' },
        { label: 'Open help requests', value: open.length, hint: `${assigned} being helped`, tone: open.length === 0 ? 'ok' : waitTone },
        { label: 'Longest wait', value: `${longestWait} min`, ...(longest ? { hint: `${teamOf(longest.teamId)?.name} · ${longest.topic}` } : { hint: 'nobody waiting' }), tone: waitTone },
        { label: 'Teams demo-ready', value: `${ready} / ${state.teams.length}`, hint: 'judging starts 15:00', tone: ready * 2 >= state.teams.length ? 'ok' : 'warn' },
        { label: 'Mentors free', value: `${free.length} / ${state.mentors.length}`, hint: free.map(firstName).join(', ') || 'all busy', tone: free.length ? 'ok' : 'bad' },
        { label: 'Tasks unclaimed', value: unclaimed, tone: unclaimed > 4 ? 'bad' : unclaimed > 1 ? 'warn' : 'ok' },
      ],
    };
  });

  register(server, 'list_teams', {
    title: 'List teams',
    description: 'Hackathon teams with track, table number, members, project status (idea/building/demo-ready) and whether they currently need a mentor (an open help request). `tone`: bad=idea, warn=building, ok=demo-ready.',
    input: z.object({ track: z.enum(['Agents', 'DevTools', 'Data']).optional().describe('Only this track.') }),
    output: z.looseObject({
      teams: z.array(z.looseObject({
        id: z.string(), name: z.string(), track: z.string(), table: z.number(), members: z.array(z.string()), memberCount: z.number(),
        projectStatus: z.string(), needsMentor: z.boolean(), tone,
      })),
      count: z.number(),
    }),
  }, ({ track }) => {
    const open = new Set(state.help.filter(r => r.status === 'open').map(r => r.teamId));
    const teams = state.teams.filter(t => !track || t.track === track).map(t => ({
      id: t.id, name: t.name, track: t.track, table: t.table, members: [...t.members], memberCount: t.members.length,
      projectStatus: t.projectStatus, needsMentor: open.has(t.id), tone: statusTone[t.projectStatus],
    }));
    return { teams, count: teams.length };
  });

  register(server, 'list_help_requests', {
    title: 'List help requests',
    description: 'Mentor help requests, longest-waiting open ones first. `waitingMinutes` counts until a mentor was assigned (still ticking while open). `tone`: bad if open > 10 min, warn if open > 5 min. `availableMentors` lists free mentors with the needed skill (ids for assign_mentor).',
    input: z.object({ status: z.enum(['open', 'assigned', 'resolved']).optional().describe('Only this status. Omit for all.') }),
    output: z.looseObject({
      requests: z.array(z.looseObject({
        id: z.number(), teamId: z.string(), teamName: z.string(), topic: z.string(), skill: z.string(), createdAt: z.string(),
        waitingMinutes: z.number(), status: z.string(), mentorId: z.string().nullable(), mentorName: z.string().nullable(),
        availableMentors: z.array(z.string()), tone,
      })),
      count: z.number(), open: z.number(), longestOpenWaitMinutes: z.number(),
    }),
  }, ({ status }) => {
    const now = Date.now();
    const order = { open: 0, assigned: 1, resolved: 2 } as const;
    const rows = state.help
      .filter(r => !status || r.status === status)
      .sort((a, b) => order[a.status] - order[b.status] || (a.status === 'resolved' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
      .map(r => helpRow(r, now));
    const open = state.help.filter(r => r.status === 'open');
    return {
      requests: rows,
      count: rows.length,
      open: open.length,
      longestOpenWaitMinutes: open.reduce((m, r) => Math.max(m, waitingMinutes(r, now)), 0),
    };
  });

  register(server, 'list_mentors', {
    title: 'List mentors',
    description: 'Mentors with skills and status (available/busy). Busy mentors show the help request they are on.',
    input: z.object({ available: z.boolean().optional().describe('true = only available mentors, false = only busy ones.') }),
    output: z.looseObject({
      mentors: z.array(z.looseObject({
        id: z.string(), name: z.string(), skills: z.array(z.string()), skillList: z.string(), status: z.enum(['available', 'busy']),
        currentRequestId: z.number().nullable(), currentRequest: z.string().nullable(), tone,
      })),
      count: z.number(), available: z.number(),
    }),
  }, ({ available }) => {
    const rows = state.mentors
      .filter(m => available === undefined || mentorAvailable(m) === available)
      .map(m => {
        const r = m.currentRequestId !== undefined ? state.help.find(x => x.id === m.currentRequestId) : undefined;
        return {
          id: m.id, name: m.name, skills: [...m.skills], skillList: m.skills.join(', '),
          status: mentorAvailable(m) ? 'available' as const : 'busy' as const,
          currentRequestId: m.currentRequestId ?? null,
          currentRequest: r ? `#${r.id} ${teamOf(r.teamId)?.name}: ${r.topic}` : null,
          tone: (mentorAvailable(m) ? 'ok' : 'warn') as Tone,
        };
      });
    return { mentors: rows, count: rows.length, available: state.mentors.filter(mentorAvailable).length };
  });

  register(server, 'get_checkins', {
    title: 'Check-ins per hour',
    description: `Badge check-ins per hour since doors opened (07:30; first bucket ${hhmm(DOORS_HOUR * 60)}), with running total, against expected attendance (${EXPECTED_ATTENDANCE}). \`rows\` suits a TimeSeries with x="hour".`,
    input: z.object({}),
    output: z.looseObject({
      rows: z.array(z.looseObject({ hour: z.string(), count: z.number(), cumulative: z.number() })),
      total: z.number(), expected: z.number(), percent: z.number(),
    }),
  }, () => {
    let cum = 0;
    const rows = [...state.checkins.entries()].sort((a, b) => a[0] - b[0]).map(([h, count]) => {
      cum += count;
      return { hour: hhmm(h * 60), count, cumulative: cum };
    });
    return { rows, total: cum, expected: EXPECTED_ATTENDANCE, percent: Math.round((cum / EXPECTED_ATTENDANCE) * 100) };
  });

  register(server, 'list_tasks', {
    title: 'List volunteer tasks',
    description: 'Volunteer tasks with area, status (todo/doing/done), owner and `version` (pass as expectedVersion to claim_task/update_task_status). `tone`: warn = unclaimed todo.',
    input: z.object({ status: z.enum(['todo', 'doing', 'done']).optional().describe('Only this status.') }),
    output: z.looseObject({
      tasks: z.array(z.looseObject({
        id: z.string(), title: z.string(), area: z.string(), status: z.string(), owner: z.string().nullable(), version: z.number(),
        updatedAt: z.string(), tone,
      })),
      count: z.number(), unclaimed: z.number(),
    }),
  }, ({ status }) => {
    const rows = state.tasks.filter(t => !status || t.status === status).map(t => ({
      id: t.id, title: t.title, area: t.area, status: t.status, owner: t.owner ?? null, version: t.version,
      updatedAt: new Date(t.updatedAt).toISOString(), tone: (t.status === 'todo' && !t.owner ? 'warn' : 'ok') as Tone,
    }));
    return { tasks: rows, count: rows.length, unclaimed: state.tasks.filter(t => t.status === 'todo' && !t.owner).length };
  });

  register(server, 'list_judging', {
    title: 'Judging queue',
    description: 'Judging slots (from 15:00, 10 minutes each) per judge and room, with the team\'s current project status. `tone`: bad = still an idea, warn = still building, ok = demo-ready.',
    input: z.object({ judge: z.string().optional().describe('Only this judge (case-insensitive substring, e.g. "Chen").') }),
    output: z.looseObject({
      slots: z.array(z.looseObject({
        slot: z.string(), judge: z.string(), room: z.string(), teamId: z.string(), teamName: z.string(), table: z.number(),
        projectStatus: z.string(), status: z.string(), tone,
      })),
      count: z.number(),
    }),
  }, ({ judge }) => {
    const q = judge?.toLowerCase();
    const rows = state.judging
      .filter(j => !q || j.judge.toLowerCase().includes(q))
      .sort((a, b) => a.slot.localeCompare(b.slot) || a.judge.localeCompare(b.judge))
      .map(j => {
        const t = teamOf(j.teamId)!;
        return { slot: j.slot, judge: j.judge, room: j.room, teamId: t.id, teamName: t.name, table: t.table, projectStatus: t.projectStatus, status: j.status, tone: statusTone[t.projectStatus] };
      });
    return { slots: rows, count: rows.length };
  });

  register(server, 'get_schedule', {
    title: 'Event schedule',
    description: 'Today\'s agenda with room, and whether each item is past, now or upcoming (by the server clock).',
    input: z.object({}),
    output: z.looseObject({
      items: z.array(z.looseObject({ time: z.string(), title: z.string(), room: z.string(), status: z.enum(['past', 'now', 'upcoming']), tone })),
      now: z.string(), next: z.string().nullable(),
    }),
  }, () => {
    const d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const items = state.schedule.map((s, i) => {
      const start = toMin(s.time);
      const end = i + 1 < state.schedule.length ? toMin(state.schedule[i + 1].time) : start + 60;
      const status = nowMin >= end ? 'past' as const : nowMin >= start ? 'now' as const : 'upcoming' as const;
      return { ...s, status, tone: (status === 'now' ? 'warn' : 'ok') as Tone /* highlight what is happening now */ };
    });
    const next = items.find(i => i.status === 'upcoming');
    return { items, now: hhmm(nowMin), next: next ? `${next.time} ${next.title}` : null };
  });

  // ---------------------------------------------------------------- writes
  register(server, 'assign_mentor', {
    title: 'Assign mentor to help request',
    description: 'Assign an available mentor to an open help request; the mentor becomes busy. Fails with a conflict if the mentor is busy or the request is not open. Use dryRun to preview.',
    input: z.object({
      requestId: z.number().int().describe('Help request id (the number in "#7").'),
      mentorId: z.string().describe('Mentor id from list_mentors, e.g. "priya" (first name also accepted).'),
      dryRun: dryRunArg,
    }),
    output: writeResult,
    write: true,
  }, ({ requestId, mentorId, dryRun }) => writeOut(!!dryRun, assignMentor(requestId, mentorId, !!dryRun)));

  register(server, 'resolve_help_request', {
    title: 'Resolve help request',
    description: 'Mark a help request resolved; its mentor (if any) becomes available again. Use dryRun to preview.',
    input: z.object({ requestId: z.number().int().describe('Help request id.'), dryRun: dryRunArg }),
    output: writeResult,
    write: true,
  }, ({ requestId, dryRun }) => writeOut(!!dryRun, resolveHelpRequest(requestId, !!dryRun)));

  register(server, 'claim_task', {
    title: 'Claim volunteer task',
    description: 'A volunteer claims a task (todo → doing). Fails if someone else owns it, it is done, or expectedVersion is stale.',
    input: z.object({
      taskId: z.string().describe('Task id, e.g. "T3".'),
      owner: z.string().min(1).describe('Volunteer name.'),
      expectedVersion: expectedVersionArg,
      dryRun: dryRunArg,
    }),
    output: writeResult,
    write: true,
    idempotent: true,
  }, ({ taskId, owner, expectedVersion, dryRun }) => writeOut(!!dryRun, claimTask(taskId, owner, expectedVersion, !!dryRun)));

  register(server, 'update_task_status', {
    title: 'Update task status',
    description: 'Move a volunteer task to todo/doing/done (todo also unassigns it). Fails if expectedVersion is stale.',
    input: z.object({
      taskId: z.string().describe('Task id, e.g. "T3".'),
      status: z.enum(['todo', 'doing', 'done']),
      expectedVersion: expectedVersionArg,
      dryRun: dryRunArg,
    }),
    output: writeResult,
    write: true,
    idempotent: true,
  }, ({ taskId, status, expectedVersion, dryRun }) => writeOut(!!dryRun, updateTaskStatus(taskId, status, expectedVersion, !!dryRun)));

  register(server, 'create_task', {
    title: 'Create volunteer task',
    description: 'Add a new unclaimed volunteer task.',
    input: z.object({
      title: z.string().min(1).describe('What needs doing, e.g. "Refill water at Station A".'),
      area: z.string().min(1).describe('Area, e.g. Food, AV, Venue, Registration, Judging, Comms.'),
      dryRun: dryRunArg,
    }),
    output: writeResult,
    write: true,
  }, ({ title, area, dryRun }) => writeOut(!!dryRun, createTask(title, area, !!dryRun)));
}
