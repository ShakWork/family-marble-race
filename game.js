const TOTAL_STARTERS = 50;
const DEFAULT_TOTAL_STAGES = 50;
const WIDTH = 1100;
const HEIGHT = 640;

const MARBLE_RADIUS = 22;
const GRAVITY = 780;
const AIR_DRAG = 0.997;
const RESTITUTION = 0.2;
const FRICTION = 0.985;
const ASSIST_DELAY_MS = 20000;
const ASSIST_RAMP_MS = 45000;
const ELIMINATION_SHOW_MS = 2300;
const RUNNER_MANIFEST_PATH = "assets/marbles/manifest.json";
const ASSIST_CHAOS_INTERVAL_MS = 950;
const STUCK_TIME_MS = 2200;
const STUCK_SPEED_EPS = 18;

const state = {
  stage: 0,
  stageLimit: DEFAULT_TOTAL_STAGES,
  roster: [],
  selectedRunnerIds: new Set(),
  marbles: [],
  qualified: [],
  lastEliminated: null,
  winner: null,
  isPaused: false,
  running: false,
  stageLayout: null,
  layouts: [],
  stageStart: 0,
  pausedAccumMs: 0,
  pauseStartedAt: 0,
  lastTs: 0,
  animationId: null,
  imagesReady: false,
  eliminationSpotlight: null,
  autoNextTimer: null,
  audioCtx: null,
  voices: [],
  speechUnlocked: false,
  speechPrimeTried: false,
  speechToken: 0,
  runnerDefs: [],
  lastChaosPulseMs: 0,
  victoryFx: null,
  victoryAnimId: null,
};

const stageEl = document.getElementById("stage");
const stageLimitEl = document.getElementById("stageLimit");
const remainingEl = document.getElementById("remaining");
const qualifiedEl = document.getElementById("qualified");
const eliminatedEl = document.getElementById("eliminated");
const winnerEl = document.getElementById("winner");
const phaseTextEl = document.getElementById("phaseText");
const eliminationLogEl = document.getElementById("eliminationLog");

const participantsBtn = document.getElementById("participantsBtn");
const participantsModal = document.getElementById("participantsModal");
const participantsListEl = document.getElementById("participantsList");
const selectAllParticipantsBtn = document.getElementById("selectAllParticipantsBtn");
const clearParticipantsBtn = document.getElementById("clearParticipantsBtn");
const cancelParticipantsBtn = document.getElementById("cancelParticipantsBtn");
const saveParticipantsBtn = document.getElementById("saveParticipantsBtn");

const startBtn = document.getElementById("startBtn");
const nextBtn = document.getElementById("nextBtn");
const resetBtn = document.getElementById("resetBtn");
const pauseBtn = document.getElementById("pauseBtn");

const canvas = document.getElementById("raceCanvas");
const ctx = canvas.getContext("2d");
const marbleImages = new Map();

function fileNameToDisplayName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function getDefaultRunnerDefs() {
  return Array.from({ length: TOTAL_STARTERS }, (_, i) => {
    const id = i + 1;
    const file = `brainrot_${String(id).padStart(2, "0")}.png`;
    return { id, file, name: `Brainrot ${id}` };
  });
}

function normalizeRunnerEntry(entry, index) {
  const id = index + 1;
  const file = String(entry?.file || entry?.filename || "").trim();
  const fallbackFile = `brainrot_${String(id).padStart(2, "0")}.png`;
  const imageFile = file || fallbackFile;
  const displayName = String(entry?.name || fileNameToDisplayName(imageFile) || `Brainrot ${id}`).trim();
  return { id, file: imageFile, name: displayName };
}

async function loadRunnerManifest() {
  try {
    const globalManifest = (typeof window !== "undefined" && window.RUNNER_MANIFEST) ? window.RUNNER_MANIFEST : null;
    if (globalManifest && Array.isArray(globalManifest.entries) && globalManifest.entries.length) {
      state.runnerDefs = globalManifest.entries.slice(0, TOTAL_STARTERS).map((entry, idx) => normalizeRunnerEntry(entry, idx));
      return;
    }

    const res = await fetch(`${RUNNER_MANIFEST_PATH}?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`manifest http ${res.status}`);
    }
    const json = await res.json();
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    if (!entries.length) {
      throw new Error("manifest empty");
    }
    state.runnerDefs = entries.slice(0, TOTAL_STARTERS).map((entry, idx) => normalizeRunnerEntry(entry, idx));
  } catch (_err) {
    state.runnerDefs = getDefaultRunnerDefs();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return { d2: ddx * ddx + ddy * ddy, cx: x1, cy: y1 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return { d2: ddx * ddx + ddy * ddy, cx, cy };
}

function distToPolyline(x, y, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const hit = distancePointToSegment(x, y, a.x, a.y, b.x, b.y);
    best = Math.min(best, Math.sqrt(hit.d2));
  }
  return best;
}

function resolveSegment(segment, t) {
  if (segment.motion && segment.motion.type === "rotate") {
    const angle = segment.motion.base + Math.sin(t * segment.motion.speed + segment.motion.phase) * segment.motion.amp;
    const half = segment.motion.length / 2;
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    return {
      ...segment,
      x1: segment.motion.cx - dx,
      y1: segment.motion.cy - dy,
      x2: segment.motion.cx + dx,
      y2: segment.motion.cy + dy,
      thickness: segment.thickness,
      push: segment.push,
    };
  }
  if (!segment.motion) {
    return segment;
  }
  if (segment.motion.type === "horizontal") {
    const off = Math.sin(t * segment.motion.speed + segment.motion.phase) * segment.motion.amp;
    return { ...segment, x1: segment.x1 + off, x2: segment.x2 + off };
  }
  if (segment.motion.type === "vertical") {
    const off = Math.sin(t * segment.motion.speed + segment.motion.phase) * segment.motion.amp;
    return { ...segment, y1: segment.y1 + off, y2: segment.y2 + off };
  }
  return segment;
}

function resolveCircle(circle, t) {
  if (!circle.motion) {
    return circle;
  }
  if (circle.motion.type === "horizontal") {
    const off = Math.sin(t * circle.motion.speed + circle.motion.phase) * circle.motion.amp;
    return { ...circle, x: circle.x + off };
  }
  if (circle.motion.type === "vertical") {
    const off = Math.sin(t * circle.motion.speed + circle.motion.phase) * circle.motion.amp;
    return { ...circle, y: circle.y + off };
  }
  return circle;
}

function resolveZone(zone, t) {
  if (!zone.motion) {
    return zone;
  }
  if (zone.motion.type === "horizontal") {
    const off = Math.sin(t * zone.motion.speed + zone.motion.phase) * zone.motion.amp;
    return { ...zone, x: zone.x + off };
  }
  if (zone.motion.type === "vertical") {
    const off = Math.sin(t * zone.motion.speed + zone.motion.phase) * zone.motion.amp;
    return { ...zone, y: zone.y + off };
  }
  return zone;
}

function makeRunner(def, index) {
  const fallbackId = index + 1;
  const safeDef = def || { id: fallbackId, file: `brainrot_${String(fallbackId).padStart(2, "0")}.png`, name: `Brainrot ${fallbackId}` };
  const runnerId = Number.isFinite(safeDef.id) ? safeDef.id : fallbackId;

  return {
    id: runnerId,
    name: safeDef.name,
    hue: (runnerId * 29) % 360,
    weight: 0.92 + Math.random() * 0.16,
    bounce: 0.16 + Math.random() * 0.12,
    skill: 0.94 + Math.random() * 0.14,
    imageKey: safeDef.file,
  };
}

function getTopSpawnPosition(slotIndex, total) {
  const margin = MARBLE_RADIUS + 8;
  const safeTotal = Math.max(1, total);
  const usableWidth = WIDTH - margin * 2;
  const step = usableWidth / safeTotal;
  const baseX = margin + step * (slotIndex + 0.5);
  const jitter = step * 0.38 * (Math.random() * 2 - 1);
  return {
    x: clamp(baseX + jitter, margin, WIDTH - margin),
    y: 36 + Math.random() * 70,
  };
}

function makeMarble(runner, slotIndex, total) {
  const pos = getTopSpawnPosition(slotIndex, total);
  return {
    runner,
    x: pos.x,
    y: pos.y,
    vx: Math.random() * 60 - 30,
    vy: Math.random() * 26,
    lastJumpAt: -999999,
    lastMoveAt: 0,
    lastX: pos.x,
    lastY: pos.y,
    lastSurfaceHopAt: -999999,
  };
}

function marbleTouchesRect(marble, rect) {
  const cx = clamp(marble.x, rect.x, rect.x + rect.w);
  const cy = clamp(marble.y, rect.y, rect.y + rect.h);
  const dx = marble.x - cx;
  const dy = marble.y - cy;
  return dx * dx + dy * dy <= MARBLE_RADIUS * MARBLE_RADIUS;
}

function inRectZone(marble, rect) {
  return marble.x >= rect.x && marble.x <= rect.x + rect.w && marble.y >= rect.y && marble.y <= rect.y + rect.h;
}

function inCircleZone(marble, zone) {
  const dx = marble.x - zone.x;
  const dy = marble.y - zone.y;
  return dx * dx + dy * dy <= zone.r * zone.r;
}


function applySurfaceHop(marble, elapsedMs, strength) {
  if (elapsedMs - marble.lastSurfaceHopAt < 170) {
    return;
  }
  marble.vy -= strength;
  marble.vx += (Math.random() * 2 - 1) * (strength * 0.5);
  marble.lastSurfaceHopAt = elapsedMs;
}
function applySegmentCollision(marble, segment, dt, t, elapsedMs) {
  const current = resolveSegment(segment, t);
  const thickness = current.thickness ?? 10;
  const hit = distancePointToSegment(marble.x, marble.y, current.x1, current.y1, current.x2, current.y2);
  const minDist = MARBLE_RADIUS + thickness;
  if (hit.d2 >= minDist * minDist) {
    return;
  }

  const dist = Math.max(0.001, Math.sqrt(hit.d2));
  const nx = (marble.x - hit.cx) / dist;
  const ny = (marble.y - hit.cy) / dist;
  const penetration = minDist - dist;

  marble.x += nx * penetration;
  marble.y += ny * penetration;

  const vn = marble.vx * nx + marble.vy * ny;
  if (vn < 0) {
    marble.vx -= (1 + RESTITUTION * marble.runner.bounce) * vn * nx;
    marble.vy -= (1 + RESTITUTION * marble.runner.bounce) * vn * ny;

    const tx = -ny;
    const ty = nx;
    const vt = marble.vx * tx + marble.vy * ty;
    marble.vx -= (1 - FRICTION * marble.runner.skill) * vt * tx;
    marble.vy -= (1 - FRICTION * marble.runner.skill) * vt * ty;
  }

  if (current.push) {
    marble.vx += current.push.x * dt;
    marble.vy += current.push.y * dt;
  }
}

function applyCircleCollision(marble, circle, dt, t, elapsedMs) {
  const c = resolveCircle(circle, t);
  const dx = marble.x - c.x;
  const dy = marble.y - c.y;
  const minDist = MARBLE_RADIUS + c.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minDist * minDist) {
    return;
  }
  const dist = Math.max(0.001, Math.sqrt(d2));
  const nx = dx / dist;
  const ny = dy / dist;
  const penetration = minDist - dist;

  marble.x += nx * penetration;
  marble.y += ny * penetration;

  const vn = marble.vx * nx + marble.vy * ny;
  if (vn < 0) {
    marble.vx -= (1 + 0.45) * vn * nx;
    marble.vy -= (1 + 0.45) * vn * ny;
  }
  if (c.push) {
    marble.vx += c.push.x * dt;
    marble.vy += c.push.y * dt;
  }
}

function canPlace(centerX, centerY, radius, placed, minGap) {
  for (let i = 0; i < placed.length; i += 1) {
    const p = placed[i];
    const dx = centerX - p.x;
    const dy = centerY - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < radius + p.r + minGap) {
      return false;
    }
  }
  return true;
}

function addGear(segments, circles, cx, cy, rng, stage, keepPriority) {
  const armLen = randRange(rng, 88, 132);
  const speed = randRange(rng, 0.75, 1.45) + stage * 0.005;
  const amp = randRange(rng, 0.7, 1.15);
  for (let k = 0; k < 3; k += 1) {
    segments.push({
      motion: {
        type: "rotate",
        cx,
        cy,
        length: armLen,
        base: k * ((Math.PI * 2) / 3),
        amp,
        speed,
        phase: randRange(rng, 0, Math.PI * 2),
      },
      thickness: randRange(rng, 7, 10),
      push: { x: randRange(rng, -18, 18), y: randRange(rng, -10, 10) },
      keepPriority,
    });
  }
  circles.push({
    x: cx,
    y: cy,
    r: randRange(rng, 17, 24),
    motion: randRange(rng, 0, 1) > 0.5
      ? { type: "horizontal", speed: randRange(rng, 0.8, 1.3), amp: randRange(rng, 8, 24), phase: randRange(rng, 0, Math.PI * 2) }
      : { type: "vertical", speed: randRange(rng, 0.8, 1.3), amp: randRange(rng, 8, 24), phase: randRange(rng, 0, Math.PI * 2) },
    keepPriority,
  });
}

function generateStageLayout(stageNumber) {
  const rng = makeRng(0x9e3779b9 ^ (stageNumber * 2654435761));
  const spawn = { x: randRange(rng, 250, 850), y: randRange(rng, 66, 98) };

  const goal = {
    x: 0,
    y: randRange(rng, HEIGHT - 70, HEIGHT - 48),
    w: WIDTH,
    h: randRange(rng, 22, 30),
  };

  const corridor = [{ x: spawn.x, y: spawn.y }];
  for (let i = 1; i <= 5; i += 1) {
    corridor.push({
      x: randRange(rng, 150, 950),
      y: 120 + i * 88 + randRange(rng, -24, 24),
    });
  }
  corridor.push({ x: randRange(rng, 260, 840), y: goal.y - 16 });

  const segments = [];
  const circles = [];
  const jumpPads = [];
  const redZones = [{ x: 0, y: HEIGHT - 30, w: WIDTH, h: 30 }];

  const placed = [];
  const segmentTarget = randInt(rng, 15, 23);
  const circleTarget = randInt(rng, 5, 10);
  const gearTarget = randInt(rng, 2, 5);

  let attempts = 0;
  let gears = 0;
  while (segments.length < segmentTarget && attempts < 600) {
    attempts += 1;
    const cx = randRange(rng, 90, WIDTH - 90);
    const cy = randRange(rng, 125, HEIGHT - 130);
    const d = distToPolyline(cx, cy, corridor);
    const len = randRange(rng, 90, 200);
    const occR = len * 0.52 + 24;
    if (d < randRange(rng, 72, 104)) {
      continue;
    }
    if (!canPlace(cx, cy, occR, placed, 22)) {
      continue;
    }

    const keepPriority = randRange(rng, 0, 1);
    if (gears < gearTarget && randRange(rng, 0, 1) < 0.26) {
      addGear(segments, circles, cx, cy, rng, stageNumber, keepPriority);
      placed.push({ x: cx, y: cy, r: occR + 25 });
      gears += 1;
      continue;
    }

    const angle = randRange(rng, -Math.PI * 0.85, Math.PI * 0.85);
    const dx = Math.cos(angle) * len * 0.5;
    const dy = Math.sin(angle) * len * 0.5;
    const moving = randRange(rng, 0, 1) < 0.7;

    if (moving) {
      const mode = randRange(rng, 0, 1);
      if (mode < 0.4) {
        segments.push({
          motion: {
            type: "rotate",
            cx,
            cy,
            length: len,
            base: angle,
            amp: randRange(rng, 0.42, 1.12),
            speed: randRange(rng, 0.75, 1.62) + stageNumber * 0.005,
            phase: randRange(rng, 0, Math.PI * 2),
          },
          thickness: randRange(rng, 7, 11),
          push: { x: randRange(rng, -16, 16), y: randRange(rng, -9, 9) },
          keepPriority,
        });
      } else {
        segments.push({
          x1: cx - dx,
          y1: cy - dy,
          x2: cx + dx,
          y2: cy + dy,
          thickness: randRange(rng, 7, 11),
          motion: {
            type: mode < 0.7 ? "horizontal" : "vertical",
            speed: randRange(rng, 0.8, 1.8) + stageNumber * 0.005,
            amp: randRange(rng, 18, 52),
            phase: randRange(rng, 0, Math.PI * 2),
          },
          push: { x: randRange(rng, -14, 14), y: randRange(rng, -8, 8) },
          keepPriority,
        });
      }
    } else {
      segments.push({
        x1: cx - dx,
        y1: cy - dy,
        x2: cx + dx,
        y2: cy + dy,
        thickness: randRange(rng, 7, 11),
        keepPriority,
      });
    }

    placed.push({ x: cx, y: cy, r: occR });
  }

  attempts = 0;
  while (circles.length < circleTarget && attempts < 500) {
    attempts += 1;
    const cx = randRange(rng, 90, WIDTH - 90);
    const cy = randRange(rng, 130, HEIGHT - 110);
    const rad = randRange(rng, 16, 28);
    const d = distToPolyline(cx, cy, corridor);
    if (d < randRange(rng, 72, 104)) {
      continue;
    }
    if (!canPlace(cx, cy, rad + 22, placed, 18)) {
      continue;
    }

    circles.push({
      x: cx,
      y: cy,
      r: rad,
      motion: randRange(rng, 0, 1) < 0.55
        ? { type: randRange(rng, 0, 1) < 0.5 ? "horizontal" : "vertical", speed: randRange(rng, 0.7, 1.6), amp: randRange(rng, 10, 34), phase: randRange(rng, 0, Math.PI * 2) }
        : null,
      push: { x: randRange(rng, -20, 20), y: randRange(rng, -12, 12) },
      keepPriority: randRange(rng, 0, 1),
    });
    placed.push({ x: cx, y: cy, r: rad + 18 });
  }

  const hazardCount = randInt(rng, 1, 3);
  attempts = 0;
  while (redZones.length < hazardCount + 1 && attempts < 200) {
    attempts += 1;
    const zx = randRange(rng, 120, WIDTH - 340);
    const zy = randRange(rng, 190, HEIGHT - 130);
    const zw = randRange(rng, 120, 220);
    const zh = randRange(rng, 12, 20);
    const centerX = zx + zw / 2;
    const centerY = zy + zh / 2;
    const d = distToPolyline(centerX, centerY, corridor);
    if (d < 46) {
      continue;
    }
    if (!canPlace(centerX, centerY, Math.max(zw * 0.5, 26), placed, 16)) {
      continue;
    }

    redZones.push({
      x: zx,
      y: zy,
      w: zw,
      h: zh,
      motion: randRange(rng, 0, 1) < 0.5
        ? { type: "horizontal", speed: randRange(rng, 1.0, 2.0), amp: randRange(rng, 55, 150), phase: randRange(rng, 0, Math.PI * 2) }
        : { type: "vertical", speed: randRange(rng, 1.0, 2.0), amp: randRange(rng, 30, 85), phase: randRange(rng, 0, Math.PI * 2) },
      keepPriority: randRange(rng, 0, 1),
    });
    placed.push({ x: centerX, y: centerY, r: zw * 0.45 + 16 });
  }

  const padCount = randInt(rng, 3, 6);
  attempts = 0;
  while (jumpPads.length < padCount && attempts < 240) {
    attempts += 1;
    const px = randRange(rng, 140, WIDTH - 240);
    const py = randRange(rng, 170, HEIGHT - 180);
    const d = distToPolyline(px + 55, py + 8, corridor);
    if (d > 115) {
      continue;
    }
    if (!canPlace(px + 55, py + 8, 70, placed, 18)) {
      continue;
    }

    jumpPads.push({
      x: px,
      y: py,
      w: randRange(rng, 90, 130),
      h: 14,
      jump: randRange(rng, 240, 380),
      steer: randRange(rng, 90, 180),
      keepPriority: randRange(rng, 0, 1),
    });
    placed.push({ x: px + 55, y: py + 8, r: 64 });
  }

  let goalType = "strip";
  let goals = [];
  if (stageNumber % 6 === 0 || stageNumber % 7 === 0) {
    goalType = "circles";
    const cupCount = stageNumber % 2 === 0 ? 3 : 4;
    for (let i = 0; i < cupCount; i += 1) {
      goals.push({
        x: (WIDTH / (cupCount + 1)) * (i + 1) + randRange(rng, -35, 35),
        y: randRange(rng, HEIGHT - 240, HEIGHT - 170),
        r: randRange(rng, 56, 76),
      });
    }
  }

  const goalCenter = goalType === "strip"
    ? { x: WIDTH / 2, y: goal.y + goal.h * 0.5 }
    : {
      x: goals.reduce((sum, g) => sum + g.x, 0) / goals.length,
      y: goals.reduce((sum, g) => sum + g.y, 0) / goals.length,
    };

  return {
    title: `שלב ייחודי ${stageNumber}`,
    spawn,
    goal,
    goalType,
    goals,
    goalCenter,
    segments,
    circles,
    jumpPads,
    redZones,
  };
}

function buildAllStages(totalStages = DEFAULT_TOTAL_STAGES) {
  const layouts = [];
  for (let i = 1; i <= totalStages; i += 1) {
    layouts.push(generateStageLayout(i));
  }
  return layouts;
}

function pickActive(items, keepRatio, minKeep) {
  if (keepRatio >= 0.999) {
    return items;
  }
  const sorted = [...items].sort((a, b) => (a.keepPriority ?? 0.5) - (b.keepPriority ?? 0.5));
  const count = clamp(Math.floor(sorted.length * keepRatio), minKeep, sorted.length);
  return sorted.slice(0, count);
}

function getAssistProfile(elapsedMs) {
  if (elapsedMs < ASSIST_DELAY_MS) {
    return {
      active: false,
      ratio: 1,
      showExtraRed: true,
      goalGrow: 0,
      guidance: 0,
      padBoost: 1,
    };
  }

  const progress = clamp((elapsedMs - ASSIST_DELAY_MS) / ASSIST_RAMP_MS, 0, 1);
  const ratio = clamp(1 - progress, 0.08, 1);
  return {
    active: true,
    ratio,
    showExtraRed: progress < 0.55,
    goalGrow: 14 + progress * 44,
    guidance: 16 + progress * 72,
    padBoost: 1 + progress * 0.45,
  };
}

function getActiveLayout(elapsedMs) {
  const p = getAssistProfile(elapsedMs);
  return {
    profile: p,
    segments: pickActive(state.stageLayout.segments, p.ratio, 3),
    circles: pickActive(state.stageLayout.circles, p.ratio, 2),
    pads: pickActive(state.stageLayout.jumpPads, Math.min(1, p.ratio + 0.25), 1),
    redZones: p.showExtraRed
      ? state.stageLayout.redZones
      : state.stageLayout.redZones.slice(0, 1),
  };
}

function resetStageMarbles() {
  state.qualified = [];
  state.marbles = state.roster.map((runner, index) => makeMarble(runner, index, state.roster.length));
}

function getEffectiveGoal(elapsedMs) {
  const profile = getAssistProfile(elapsedMs);
  if (state.stageLayout.goalType !== "strip") {
    return null;
  }
  const g = state.stageLayout.goal;
  if (!profile.active) {
    return g;
  }
  return {
    x: g.x,
    y: g.y - profile.goalGrow,
    w: g.w,
    h: g.h + profile.goalGrow + 16,
  };
}

function maybeQualify(marble, elapsedMs) {
  const profile = getAssistProfile(elapsedMs);
  if (state.stageLayout.goalType === "strip") {
    return inRectZone(marble, getEffectiveGoal(elapsedMs));
  }
  return state.stageLayout.goals.some((g) => inCircleZone(marble, { ...g, r: g.r + profile.goalGrow * 0.35 }));
}

function isRed(marble, tSec, elapsedMs) {
  const active = getActiveLayout(elapsedMs);
  const needed = state.roster.length - 1;
  return active.redZones.some((zone) => marbleTouchesRect(marble, resolveZone(zone, tSec)));
}

function respawn(marble, elapsedMs) {
  const margin = MARBLE_RADIUS + 8;
  marble.x = margin + Math.random() * (WIDTH - margin * 2);
  marble.y = 36 + Math.random() * 70;
  marble.vx = Math.random() * 64 - 32;
  marble.vy = Math.random() * 26 + 4;
  marble.lastMoveAt = elapsedMs;
  marble.lastX = marble.x;
  marble.lastY = marble.y;
  marble.lastSurfaceHopAt = elapsedMs;
}


function releaseMarbleIfStuck(marble, elapsedMs) {
  const dx = marble.x - marble.lastX;
  const dy = marble.y - marble.lastY;
  const moved = Math.sqrt(dx * dx + dy * dy);
  const speed = Math.sqrt(marble.vx * marble.vx + marble.vy * marble.vy);

  if (moved > 10 || speed > STUCK_SPEED_EPS) {
    marble.lastMoveAt = elapsedMs;
    marble.lastX = marble.x;
    marble.lastY = marble.y;
    return;
  }

  if (elapsedMs - marble.lastMoveAt < STUCK_TIME_MS) {
    return;
  }

  const goal = state.stageLayout.goalCenter;
  const gx = goal.x - marble.x;
  const gy = goal.y - marble.y;
  const towardGoal = Math.atan2(gy, gx);
  const randomPart = (Math.random() * Math.PI * 2) - Math.PI;
  const angle = towardGoal * 0.65 + randomPart * 0.35;

  marble.vx += Math.cos(angle) * (140 + Math.random() * 130);
  marble.vy -= 180 + Math.random() * 170;

  if (marble.x < 220 && marble.y < 240) {
    marble.vx += 220 + Math.random() * 140;
    marble.vy += 60;
  }

  marble.lastMoveAt = elapsedMs;
  marble.lastX = marble.x;
  marble.lastY = marble.y;
}
function marbleProgress(marble) {
  const g = state.stageLayout.goalCenter;
  return marble.y * 1.24 - Math.abs(marble.x - g.x) * 0.22;
}

function ensureAudioReady() {
  if (!state.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      state.audioCtx = new AC();
    }
  }
  if (state.audioCtx && state.audioCtx.state !== "running") {
    state.audioCtx.resume().catch(() => {});
  }
  primeSpeechIfNeeded();
}

function playEliminationChime() {
  if (!state.audioCtx) {
    return;
  }
  const now = state.audioCtx.currentTime;
  const notes = [440, 660, 880];
  notes.forEach((freq, idx) => {
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + idx * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.18, now + idx * 0.1 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.1 + 0.14);
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start(now + idx * 0.1);
    osc.stop(now + idx * 0.16);
  });
}

function refreshVoices() {
  const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  state.voices = list || [];
}

function chooseVoice() {
  if (!state.voices.length) {
    return null;
  }
  return (
    state.voices.find((v) => /he-IL/i.test(v.lang)) ||
    state.voices.find((v) => /^he/i.test(v.lang)) ||
    state.voices[0]
  );
}

function primeSpeechIfNeeded() {
  if (!("speechSynthesis" in window) || state.speechPrimeTried) {
    return;
  }
  state.speechPrimeTried = true;
  try {
    refreshVoices();
    const u = new SpeechSynthesisUtterance("ready");
    const voice = chooseVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "he-IL";
    }
    u.rate = 1;
    u.pitch = 1;
    u.volume = 0.01;
    u.onstart = () => {
      state.speechUnlocked = true;
    };
    u.onend = () => {
      state.speechUnlocked = true;
      window.speechSynthesis.cancel();
    };
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  } catch (_err) {
    state.speechPrimeTried = false;
  }
}

function speakAttempt(text, token, attempt) {
  if (!("speechSynthesis" in window) || token !== state.speechToken) {
    return;
  }
  refreshVoices();
  let started = false;
  const u = new SpeechSynthesisUtterance(text);
  const voice = chooseVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = "he-IL";
  }
  u.rate = 0.82;
  u.pitch = 1;
  u.volume = 1;
  u.onstart = () => {
    started = true;
    state.speechUnlocked = true;
  };
  u.onerror = () => {
    if (token === state.speechToken && attempt < 3) {
      setTimeout(() => speakAttempt(text, token, attempt + 1), 220);
    }
  };
  try {
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  } catch (_err) {
    if (token === state.speechToken && attempt < 3) {
      setTimeout(() => speakAttempt(text, token, attempt + 1), 220);
    }
    return;
  }

  setTimeout(() => {
    if (!started && token === state.speechToken && attempt < 3) {
      speakAttempt(text, token, attempt + 1);
    }
  }, 380);
}

function speakText(text, delayMs) {
  const token = ++state.speechToken;
  setTimeout(() => {
    if (!("speechSynthesis" in window) || token !== state.speechToken) {
      return;
    }
    speakAttempt(text, token, 1);
  }, delayMs);
}
function announceElimination(name) {
  ensureAudioReady();
  playEliminationChime();

  if (!("speechSynthesis" in window)) {
    return;
  }

  window.speechSynthesis.cancel();
  const text = `${name} הודח`;
  speakText(text, 90);
}

function announceWinner(name) {
  ensureAudioReady();

  if (state.audioCtx) {
    const now = state.audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.2, now + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.18);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.2);
    });
  }

  if (!("speechSynthesis" in window)) {
    return;
  }

  window.speechSynthesis.cancel();
  const text = `${name} הוא המנצח`;
  speakText(text, 120);
}

function spawnFireworkBurst(cx, cy) {
  if (!state.victoryFx) {
    return;
  }
  const count = 36;
  const hue = Math.floor(Math.random() * 360);
  for (let i = 0; i < count; i += 1) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.2;
    const speed = 90 + Math.random() * 180;
    state.victoryFx.particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 0.7 + Math.random() * 0.8,
      age: 0,
      size: 2 + Math.random() * 3,
      hue,
    });
  }
}

function startVictoryEffects(winner) {
  if (state.victoryAnimId) {
    cancelAnimationFrame(state.victoryAnimId);
    state.victoryAnimId = null;
  }

  const now = performance.now();
  state.victoryFx = {
    runner: winner,
    particles: [],
    lastTick: now,
    nextBurst: now,
    endAt: now + 10000,
  };

  const loop = () => {
    if (!state.victoryFx) {
      return;
    }

    const t = performance.now();
    const dt = Math.min(0.05, (t - state.victoryFx.lastTick) / 1000);
    state.victoryFx.lastTick = t;

    if (t >= state.victoryFx.nextBurst) {
      spawnFireworkBurst(120 + Math.random() * (WIDTH - 240), 90 + Math.random() * 260);
      state.victoryFx.nextBurst = t + 220;
    }

    const parts = state.victoryFx.particles;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 280 * dt;
      p.vx *= 0.992;
      if (p.age >= p.life) {
        parts.splice(i, 1);
      }
    }

    draw();

    if (t < state.victoryFx.endAt) {
      state.victoryAnimId = requestAnimationFrame(loop);
    } else {
      state.victoryAnimId = null;
      draw();
    }
  };

  state.victoryAnimId = requestAnimationFrame(loop);
}

function drawVictoryEffects() {
  if (!state.victoryFx) {
    return;
  }

  state.victoryFx.particles.forEach((p) => {
    const alpha = 1 - p.age / p.life;
    ctx.fillStyle = `hsla(${p.hue}, 95%, 60%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });

  const winner = state.victoryFx.runner;
  if (!winner) {
    return;
  }

  const img = marbleImages.get(winner.imageKey);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 - 20;
  const r = 120;

  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(255,215,0,0.95)";
  ctx.stroke();

  ctx.fillStyle = "#ffe066";
  ctx.textAlign = "center";
  ctx.font = "bold 46px Segoe UI";
  ctx.fillText("המנצח!", cx, cy + 165);
  ctx.font = "bold 34px Segoe UI";
  ctx.fillText(winner.name, cx, cy + 205);
}
function getStageElapsedMs(tsMs) {
  if (!state.stageStart) {
    return 0;
  }
  const nowTs = typeof tsMs === "number" ? tsMs : state.lastTs;
  return Math.max(0, nowTs - state.stageStart * 1000 - state.pausedAccumMs);
}

function syncPauseButton() {
  if (!pauseBtn) {
    return;
  }
  pauseBtn.textContent = state.isPaused ? "המשך" : "השהה";
  pauseBtn.disabled = !state.running && !state.isPaused;
}

function togglePause() {
  if (state.winner || state.stage === 0) {
    return;
  }

  if (state.running) {
    state.running = false;
    state.isPaused = true;
    state.pauseStartedAt = performance.now();
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
      state.animationId = null;
    }
    phaseTextEl.textContent = `שלב ${state.stage} בהשהיה`;
    syncPauseButton();
    return;
  }

  if (state.isPaused) {
    state.isPaused = false;
    state.pausedAccumMs += Math.max(0, performance.now() - state.pauseStartedAt);
    state.pauseStartedAt = 0;
    state.lastTs = 0;
    state.running = true;
    phaseTextEl.textContent = `שלב ${state.stage} רץ...`;
    syncPauseButton();
    state.animationId = requestAnimationFrame(frame);
  }
}
function drawBg() {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "#313131";
  ctx.font = "bold 44px Georgia";
  ctx.textAlign = "left";
  ctx.fillText("מרוץ הגולות המשפחתי", 18, 46);

  ctx.fillStyle = "#f4f4f5";
  ctx.font = "bold 54px Georgia";
  ctx.textAlign = "right";
  ctx.fillText(`STAGE ${state.stage || 0}`, WIDTH - 16, 56);

  if (state.stageLayout?.title) {
    ctx.font = "bold 22px Segoe UI";
    ctx.fillStyle = "#a3a3a3";
    ctx.textAlign = "center";
    ctx.fillText(state.stageLayout.title, WIDTH / 2, 52);
  }
}

function drawLayout(tSec, elapsedMs) {
  if (!state.stageLayout) {
    return;
  }

  const active = getActiveLayout(elapsedMs);
  const needed = state.roster.length - 1;
  const profile = active.profile;

  if (state.stageLayout.goalType === "strip") {
    const g = getEffectiveGoal(elapsedMs);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(g.x, g.y, g.w, g.h);
  } else {
    ctx.fillStyle = "#00ff00";
    state.stageLayout.goals.forEach((goal) => {
      ctx.beginPath();
      ctx.arc(goal.x, goal.y, goal.r + profile.goalGrow * 0.35, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  active.redZones.forEach((zone) => {
    const z = resolveZone(zone, tSec);
    ctx.fillStyle = "#ff2b17";
    ctx.fillRect(z.x, z.y, z.w, z.h);
  });

  ctx.fillStyle = "#22d3ee";
  active.pads.forEach((pad) => {
    ctx.fillRect(pad.x, pad.y, pad.w, pad.h);
  });

  ctx.strokeStyle = "#a1a1aa";
  ctx.lineCap = "round";
  active.segments.forEach((seg) => {
    const s = resolveSegment(seg, tSec);
    ctx.lineWidth = (s.thickness || 10) * 2;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  });

  active.circles.forEach((circle) => {
    const c = resolveCircle(circle, tSec);
    ctx.fillStyle = "#a1a1aa";
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawMarbleImage(m) {
  const img = marbleImages.get(m.runner.imageKey);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(m.x, m.y, MARBLE_RADIUS, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, m.x - MARBLE_RADIUS, m.y - MARBLE_RADIUS, MARBLE_RADIUS * 2, MARBLE_RADIUS * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.fillStyle = `hsl(${m.runner.hue}, 85%, 58%)`;
    ctx.arc(m.x, m.y, MARBLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(m.x, m.y, MARBLE_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(m.x - 6, m.y - 7, 5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.26)";
  ctx.fill();
}

function drawMarbles() {
  state.marbles.forEach(drawMarbleImage);
}

function drawEliminationSpotlight() {
  if (!state.eliminationSpotlight) {
    return;
  }
  if (performance.now() > state.eliminationSpotlight.until) {
    state.eliminationSpotlight = null;
    return;
  }

  const runner = state.eliminationSpotlight.runner;
  const img = marbleImages.get(runner.imageKey);

  ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2 - 20;
  const r = 105;

  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.fillStyle = `hsl(${runner.hue}, 85%, 58%)`;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "bold 42px Segoe UI";
  ctx.fillText("הודח", cx, cy + 155);
  ctx.font = "bold 34px Segoe UI";
  ctx.fillText(runner.name, cx, cy + 198);
}

function draw() {
  drawBg();
  const tSec = state.stageStart + state.lastTs / 1000;
  const elapsedMs = getStageElapsedMs(state.lastTs);
  drawLayout(tSec, elapsedMs);
  drawMarbles();
  drawEliminationSpotlight();
  drawVictoryEffects();
}

function finishStage() {
  state.running = false;
  state.isPaused = false;
  syncPauseButton();

  const sortedActive = [...state.marbles].sort((a, b) => marbleProgress(b) - marbleProgress(a));
  const loser = sortedActive[sortedActive.length - 1]?.runner;

  state.lastEliminated = loser || null;
  state.roster = [...state.qualified.map((m) => m.runner)];

  if (loser) {
    const line = document.createElement("li");
    line.textContent = `שלב ${state.stage}: ${loser.name} אחרון ולכן הודח`;
    eliminationLogEl.appendChild(line);
    state.eliminationSpotlight = {
      runner: loser,
      until: performance.now() + ELIMINATION_SHOW_MS,
    };
    announceElimination(loser.name);
  }

  if (state.roster.length <= 1 || state.stage >= state.stageLimit) {
    state.winner = state.roster[0] || null;
    phaseTextEl.textContent = state.winner
      ? `המשחק הסתיים - המנצח הוא ${state.winner.name}`
      : "המשחק הסתיים ללא מנצח";
    if (state.winner) {
      announceWinner(state.winner.name);
      startVictoryEffects(state.winner);
    }
    startBtn.disabled = true;
    nextBtn.disabled = true;
    updateUi();
    draw();
    return;
  }

  nextBtn.disabled = true;
  phaseTextEl.textContent = `שלב ${state.stage} הושלם. מעבר אוטומטי לשלב הבא...`;
  updateUi();
  draw();

  state.autoNextTimer = setTimeout(() => {
    state.autoNextTimer = null;
    if (!state.running && !state.winner && state.roster.length > 1) {
      startStage();
    }
  }, ELIMINATION_SHOW_MS);
}

function update(dt, elapsedMs, ts) {
  const tSec = state.stageStart + ts / 1000;
  const active = getActiveLayout(elapsedMs);
  const needed = state.roster.length - 1;

  for (let i = state.marbles.length - 1; i >= 0; i -= 1) {
    const m = state.marbles[i];

    m.vy += (GRAVITY / m.runner.weight) * dt;
    m.vx *= AIR_DRAG;
    m.vy *= AIR_DRAG;

    if (active.profile.active) {
      const gx = state.stageLayout.goalCenter.x - m.x;
      const gy = state.stageLayout.goalCenter.y - m.y;
      m.vx += gx * (0.018 + active.profile.guidance * 0.0002) * dt;
      m.vy += gy * (0.022 + active.profile.guidance * 0.00022) * dt;
    }

    m.x += m.vx * dt;
    m.y += m.vy * dt;

    if (m.x < MARBLE_RADIUS) {
      m.x = MARBLE_RADIUS;
      m.vx = Math.abs(m.vx) * 0.35;
    }
    if (m.x > WIDTH - MARBLE_RADIUS) {
      m.x = WIDTH - MARBLE_RADIUS;
      m.vx = -Math.abs(m.vx) * 0.35;
    }
    if (m.y < MARBLE_RADIUS) {
      m.y = MARBLE_RADIUS;
      m.vy = Math.abs(m.vy) * 0.3;
    }
    if (m.y > HEIGHT - MARBLE_RADIUS) {
      m.y = HEIGHT - MARBLE_RADIUS;
      m.vy = -Math.abs(m.vy) * 0.18;
    }

    active.segments.forEach((seg) => applySegmentCollision(m, seg, dt, tSec, elapsedMs));
    active.circles.forEach((circle) => applyCircleCollision(m, circle, dt, tSec, elapsedMs));

    for (let p = 0; p < active.pads.length; p += 1) {
      const pad = active.pads[p];
      if (marbleTouchesRect(m, pad) && elapsedMs - m.lastJumpAt > 260) {
        m.vy -= pad.jump * active.profile.padBoost;
        const jumpAngle = (Math.random() * Math.PI * 2) - Math.PI;
        m.vx += Math.cos(jumpAngle) * pad.steer * 0.55;
        m.lastJumpAt = elapsedMs;
      }
    }

    releaseMarbleIfStuck(m, elapsedMs);

    if (maybeQualify(m, elapsedMs)) {
      if (state.qualified.length < needed) {
        state.qualified.push(m);
        state.marbles.splice(i, 1);
        continue;
      }
      m.vy -= 120;
      m.vx += (Math.random() * 2 - 1) * 80;
    }

    if (isRed(m, tSec, elapsedMs)) {
      respawn(m, elapsedMs);
    }
  }

  if (active.profile.active && state.qualified.length < needed && elapsedMs - state.lastChaosPulseMs >= ASSIST_CHAOS_INTERVAL_MS) {
    state.lastChaosPulseMs = elapsedMs;
    state.marbles.forEach((m) => {
      const a = Math.random() * Math.PI * 2;
      const impulse = 220 + Math.random() * 420;
      m.vx += Math.cos(a) * impulse;
      m.vy += Math.sin(a) * impulse - (220 + Math.random() * 280);
    });
  }

  if (state.qualified.length >= needed && state.marbles.length >= 1) {
    finishStage();
    return;
  }

  updateUi();
}

function frame(ts) {
  if (!state.running) {
    return;
  }

  if (!state.lastTs) {
    state.lastTs = ts;
  }

  const dt = Math.min(0.033, (ts - state.lastTs) / 1000);
  const elapsedMs = getStageElapsedMs(ts);
  state.lastTs = ts;

  update(dt, elapsedMs, ts);

  if (elapsedMs > ASSIST_DELAY_MS && state.running) {
    phaseTextEl.textContent = `שלב ${state.stage} רץ... מצב עזרה`;
  } else if (state.running) {
    phaseTextEl.textContent = `שלב ${state.stage} רץ... עברו ${state.qualified.length}/${state.roster.length - 1}`;
  }

  draw();

  if (state.running) {
    state.animationId = requestAnimationFrame(frame);
  }
}

function startStage() {
  if (state.running || state.winner) {
    return;
  }
  if (state.autoNextTimer) {
    clearTimeout(state.autoNextTimer);
    state.autoNextTimer = null;
  }
  if (state.victoryAnimId) {
    cancelAnimationFrame(state.victoryAnimId);
    state.victoryAnimId = null;
  }
  state.victoryFx = null;
  state.eliminationSpotlight = null;

  ensureAudioReady();

  state.stage += 1;
  state.stageLayout = state.layouts[state.stage - 1];
  state.stageStart = performance.now() / 1000;
  state.lastTs = 0;
  state.lastChaosPulseMs = 0;

  resetStageMarbles();
  updateUi();
  draw();

  startBtn.disabled = true;
  nextBtn.disabled = true;
  state.running = true;
  syncPauseButton();
  state.animationId = requestAnimationFrame(frame);
}

function preloadMarbleImages() {
  const promises = [];
  const imageKeys = new Set();
  const defs = state.runnerDefs.length ? state.runnerDefs : getDefaultRunnerDefs();

  defs.forEach((def) => imageKeys.add(def.file));

  imageKeys.forEach((key) => {
    const src = `assets/marbles/${key}`;
    const img = new Image();
    const p = new Promise((resolve) => {
      img.onload = () => {
        marbleImages.set(key, img);
        resolve();
      };
      img.onerror = () => resolve();
    });
    img.src = src;
    promises.push(p);
  });

  return Promise.all(promises);
}

function initGame() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId);
  }
  if (state.autoNextTimer) {
    clearTimeout(state.autoNextTimer);
    state.autoNextTimer = null;
  }
  if (state.victoryAnimId) {
    cancelAnimationFrame(state.victoryAnimId);
    state.victoryAnimId = null;
  }
  state.victoryFx = null;

  state.stage = 0;
  if (!state.runnerDefs.length) {
    state.runnerDefs = getDefaultRunnerDefs();
  }
  const allDefs = state.runnerDefs.slice(0, TOTAL_STARTERS);
  const selectedDefs = allDefs.filter((def) => state.selectedRunnerIds.has(def.id));
  const activeDefs = selectedDefs.length ? selectedDefs : allDefs;

  state.stageLimit = activeDefs.length || DEFAULT_TOTAL_STAGES;
  state.layouts = buildAllStages(state.stageLimit);
  state.roster = activeDefs.map((def, i) => makeRunner(def, i));
  state.marbles = [];
  state.qualified = [];
  state.lastEliminated = null;
  state.winner = null;
  state.running = false;
  state.isPaused = false;
  syncPauseButton();
  state.stageLayout = null;
  state.eliminationSpotlight = null;
  eliminationLogEl.innerHTML = "";

  startBtn.disabled = false;
  nextBtn.disabled = true;
  phaseTextEl.textContent = "מוכן להתחלה";
  syncPauseButton();

  updateUi();
  draw();
}

function updateUi() {
  stageEl.textContent = String(state.stage);
  stageLimitEl.textContent = String(state.stageLimit);
  remainingEl.textContent = String(state.roster.length);
  qualifiedEl.textContent = String(state.qualified.length);
  eliminatedEl.textContent = state.lastEliminated ? state.lastEliminated.name : "-";
  winnerEl.textContent = state.winner ? state.winner.name : "-";
}

function renderParticipantsPicker() {
  if (!participantsListEl) {
    return;
  }
  const defs = state.runnerDefs.slice(0, TOTAL_STARTERS);
  participantsListEl.innerHTML = "";

  defs.forEach((def) => {
    const item = document.createElement("label");
    item.className = "participant-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(def.id);
    input.checked = state.selectedRunnerIds.has(def.id);

    const text = document.createElement("span");
    text.textContent = def.name;

    item.appendChild(input);
    item.appendChild(text);
    participantsListEl.appendChild(item);
  });
}

function openParticipantsModal() {
  renderParticipantsPicker();
  participantsModal.classList.remove("hidden");
}

function closeParticipantsModal() {
  participantsModal.classList.add("hidden");
}

function setAllParticipantsChecked(checked) {
  if (!participantsListEl) {
    return;
  }
  participantsListEl.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.checked = checked;
  });
}

function saveParticipantsSelection() {
  if (!participantsListEl) {
    return;
  }

  const selectedIds = new Set();
  participantsListEl.querySelectorAll('input[type="checkbox"]:checked').forEach((el) => {
    selectedIds.add(Number(el.value));
  });

  const allDefs = state.runnerDefs.slice(0, TOTAL_STARTERS);
  if (!selectedIds.size) {
    state.selectedRunnerIds = new Set(allDefs.map((def) => def.id));
    phaseTextEl.textContent = "לא נבחרו משתתפים, נשארת ברירת המחדל: 50 משתתפים ו-50 שלבים";
  } else {
    state.selectedRunnerIds = selectedIds;
  }

  closeParticipantsModal();
  initGame();
}
pauseBtn.addEventListener("click", () => {
  ensureAudioReady();
  togglePause();
});

startBtn.addEventListener("click", () => {
  ensureAudioReady();
  startStage();
});
nextBtn.addEventListener("click", () => {
  ensureAudioReady();
  startStage();
});
participantsBtn.addEventListener("click", () => {
  openParticipantsModal();
});

selectAllParticipantsBtn.addEventListener("click", () => {
  setAllParticipantsChecked(true);
});

clearParticipantsBtn.addEventListener("click", () => {
  setAllParticipantsChecked(false);
});

cancelParticipantsBtn.addEventListener("click", () => {
  closeParticipantsModal();
});

saveParticipantsBtn.addEventListener("click", () => {
  saveParticipantsSelection();
});

participantsModal.addEventListener("click", (event) => {
  if (event.target === participantsModal) {
    closeParticipantsModal();
  }
});
resetBtn.addEventListener("click", () => {
  ensureAudioReady();
  initGame();
});

if ("speechSynthesis" in window && typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}
refreshVoices();

async function bootstrap() {
  await loadRunnerManifest();
  state.selectedRunnerIds = new Set(state.runnerDefs.slice(0, TOTAL_STARTERS).map((def) => def.id));
  renderParticipantsPicker();
  await preloadMarbleImages();
  state.imagesReady = true;
  initGame();
  if (!state.running && state.stage === 0) {
    startBtn.disabled = false;
    phaseTextEl.textContent = "מוכן להתחלה";
  syncPauseButton();
  }
}

bootstrap();





























