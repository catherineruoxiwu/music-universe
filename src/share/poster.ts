import { Camera, type Insets } from '../graph/camera';
import { GraphVisibility, isDefaultFilter, linkedWorks, type GraphFilter } from '../graph/graph';
import { GraphPainter } from '../graph/painter';
import type { UniverseSnapshot } from '../graph/snapshot';
import { SERIF, SANS, type PosterTheme } from '../graph/theme';
import { GRAPHED, rolePlural } from '../model/types';

export type PosterRatio = 'SQUARE' | 'STORY';

/** Exported size in pixels. */
export const POSTER_SIZE: Record<PosterRatio, { width: number; height: number }> = {
  SQUARE: { width: 2160, height: 2160 },
  STORY: { width: 2160, height: 3840 },
};

/** Every sentence printed on the poster, decided by the caller. */
export interface PosterText {
  title: string;
  subtitle: string;
  /** Label under the first of the three statistics. */
  worksLabel: string;
  /** The data-coverage statement; always printed. */
  coverage: string;
  credit: string;
}

export interface PosterSpec {
  snapshot: UniverseSnapshot;
  filter: GraphFilter;
  theme: PosterTheme;
  ratio: PosterRatio;
  showNames: boolean;
  showStats: boolean;
  text: PosterText;
}

/** The three figures printed on a poster; the same counting the Universe screen uses. */
export function posterStats(snapshot: UniverseSnapshot, filter: GraphFilter): { works: number; artists: number; creators: number } {
  const graph = snapshot.graph;
  const visibility = GraphVisibility.compute(graph, filter);
  return {
    works: isDefaultFilter(filter) ? graph.stats.songs + graph.stats.albums : linkedWorks(graph, visibility),
    artists: graph.nodes.filter((node) => visibility.nodes[node.index] && node.hasRole('ARTIST')).length,
    creators: visibility.nodeCount,
  };
}

/** Only turn the map when it buys a clearly bigger drawing. */
const TURN_GAIN = 1.15;

/**
 * Draws the poster on its own canvas. It frames the graph to fit the poster, independent of
 * whatever part of the map happens to be on screen, and uses the same painter as the interactive
 * map, so the poster can only ever show connections the map really has.
 *
 * @param width output width in pixels; height follows the spec's ratio. The preview and the
 *   export call this with different widths and are otherwise identical.
 */
export function renderPoster(spec: PosterSpec, width: number): HTMLCanvasElement {
  const size = POSTER_SIZE[spec.ratio];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((width * size.height) / size.width);
  drawPoster(canvas.getContext('2d')!, spec, canvas.width, canvas.height);
  return canvas;
}

export function drawPoster(ctx: CanvasRenderingContext2D, spec: PosterSpec, width: number, height: number): void {
  const theme = spec.theme;
  const u = width / 1080; // one poster unit; all sizes below are in these
  const margin = 76 * u;
  // Text unit. The square poster has far less height to spare than the story one, so its title,
  // legend and figures are set a little smaller and the map gets the difference.
  const t = spec.ratio === 'SQUARE' ? u * 0.82 : u;

  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, theme.backgroundTop);
  background.addColorStop(1, theme.backgroundBottom);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const titleFont = `${68 * t}px ${SERIF}`;
  const textFont = `${30 * t}px ${SANS}`;
  const smallFont = `${23 * t}px ${SANS}`;
  const legendFont = `${25 * t}px ${SANS}`;
  const numberFont = `${58 * t}px ${SERIF}`;

  const text = (value: string, x: number, y: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  const measure = (value: string, font: string) => {
    ctx.font = font;
    return ctx.measureText(value).width;
  };
  const ellipsize = (value: string, font: string, room: number) => {
    if (measure(value, font) <= room) return value;
    let cut = value;
    while (cut.length > 1 && measure(cut + '…', font) > room) cut = cut.slice(0, -1);
    return cut.trimEnd() + '…';
  };

  // --- header -----------------------------------------------------------------------------------
  const available = width - 2 * margin;
  let y = margin + 62 * t;
  text(ellipsize(spec.text.title, titleFont, available), margin, y, titleFont, theme.title);
  y += 50 * t;
  text(ellipsize(spec.text.subtitle, textFont, available), margin, y, textFont, theme.text);
  const headerBottom = y + 28 * t;

  // --- footer, measured from the bottom up --------------------------------------------------------
  let footerY = height - margin;
  const creditWidth = measure(spec.text.credit, smallFont);
  text(spec.text.credit, width - margin - creditWidth, footerY, smallFont, theme.faint);
  text(ellipsize(spec.text.coverage, smallFont, available - creditWidth - 24 * t), margin, footerY, smallFont, theme.faint);
  footerY -= 58 * t;

  // Legend: only the roles this poster actually shows.
  const graph = spec.snapshot.graph;
  const visibility = GraphVisibility.compute(graph, spec.filter);
  const legendRoles = GRAPHED.filter((role) => graph.nodes.some((node) => visibility.nodes[node.index] && node.hasRole(role)));
  const legendWidth =
    legendRoles.reduce((sum, role) => sum + 30 * t + measure(rolePlural(role), legendFont), 0) +
    36 * t * Math.max(legendRoles.length - 1, 0);

  const drawLegend = (startX: number, baseline: number) => {
    let x = startX;
    for (const role of legendRoles) {
      ctx.fillStyle = theme.style.roleColors[role];
      ctx.beginPath();
      ctx.arc(x + 9 * t, baseline - 9 * t, 9 * t, 0, Math.PI * 2);
      ctx.fill();
      x += 30 * t;
      text(rolePlural(role), x, baseline, legendFont, theme.text);
      x += measure(rolePlural(role), legendFont) + 36 * t;
    }
  };

  if (spec.showStats) {
    const stats = posterStats(spec.snapshot, spec.filter);
    const columns: [number, string][] = [
      [stats.works, spec.text.worksLabel],
      [stats.artists, 'Artists'],
      [stats.creators, 'Creators'],
    ];
    let x = margin;
    for (const [value, label] of columns) {
      text(String(value), x, footerY - 34 * t, numberFont, theme.title);
      text(label, x, footerY, smallFont, theme.faint);
      x += Math.max(measure(String(value), numberFont), measure(label, smallFont)) + 64 * t;
    }
    // The legend shares the statistics' row when there is room beside them, which leaves more of
    // the page to the map; otherwise it gets a row of its own above.
    if (x + legendWidth <= width - margin) {
      drawLegend(width - margin - legendWidth, footerY);
      footerY -= 122 * t;
    } else {
      footerY -= 122 * t;
      drawLegend(margin, footerY);
      footerY -= 60 * t;
    }
  } else {
    drawLegend(margin, footerY);
    footerY -= 60 * t;
  }
  const footerTop = footerY;

  // --- the graph ----------------------------------------------------------------------------------
  const regionLeft = margin * 0.5;
  const regionTop = headerBottom;
  const regionWidth = width - margin;
  const regionHeight = footerTop - headerBottom;
  if (graph.nodes.length === 0 || visibility.nodeCount === 0 || regionHeight <= 0) return;

  const camera = new Camera();
  camera.viewWidth = regionWidth;
  camera.viewHeight = regionHeight;
  camera.minScale = 0.0001;
  camera.maxScale = 1000;

  // Room for labels under the outermost nodes. The header already leaves air above the map.
  const pad: Insets = { left: 46 * u, top: 20 * u, right: 46 * u, bottom: 54 * u };
  // The layout has no "up": only who is near whom means anything. So a wide map going onto a tall
  // poster (or the reverse) is turned a quarter to use the page.
  let snapshot = spec.snapshot;
  let bounds = snapshot.bounds(visibility.nodes);
  const turned = snapshot.quarterTurned();
  const turnedBounds = turned.bounds(visibility.nodes);
  if (camera.scaleToFit(turnedBounds, pad) > camera.scaleToFit(bounds, pad) * TURN_GAIN) {
    snapshot = turned;
    bounds = turnedBounds;
  }
  // The cap stops a tiny graph being blown up until three people fill the page.
  camera.fit(bounds, pad, 2.4 * u);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, regionTop, width, regionHeight);
  ctx.clip();
  ctx.translate(regionLeft, regionTop);
  new GraphPainter(theme.style).draw(ctx, snapshot, camera, {
    visibility,
    density: u * 1.5,
    edgeOpacity: 0.9,
    showLabels: spec.showNames,
    minLabelRadius: 0,
    alwaysLabelTop: 12,
    // Enough names to recognise the map by, few enough that they do not bury it.
    maxLabels: spec.ratio === 'STORY' ? 60 : 32,
    showRoleLine: false,
    glowOpacity: theme.glowOpacity,
    labelSize: 22 * u,
    minNodeRadius: 3.2 * u,
    cull: false,
    emphasisRole: spec.filter.role,
  });
  ctx.restore();
}
