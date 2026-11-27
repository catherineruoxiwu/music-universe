import type { GraphStyle } from './painter';

export const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
export const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Noto Serif", Georgia, serif';

/** The map as shown on screen. Keep in step with the custom properties in styles.css. */
export const SCREEN_STYLE: GraphStyle = {
  edge: '#B9A3F5',
  edgeHighlight: '#F2EEFA',
  label: '#F2EEFA',
  labelSecondary: '#A9A1BD',
  labelOutline: '#0D0B14',
  selection: '#F2EEFA',
  glow: '#B9A3F5',
  roleColors: {
    ARTIST: '#B79CFF',
    PRODUCER: '#63D6C0',
    SONGWRITER: '#F4B76A',
    MUSICIAN: '#74A9FF',
    OTHER: '#6F6885',
  },
  labelFont: SANS,
};

/** Colours for one poster look. Role colours are part of the theme and the legend follows them. */
export interface PosterTheme {
  id: string;
  name: string;
  backgroundTop: string;
  backgroundBottom: string;
  title: string;
  text: string;
  faint: string;
  glowOpacity: number;
  style: GraphStyle;
}

export const POSTER_THEMES: PosterTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    backgroundTop: '#0D0B14',
    backgroundBottom: '#171228',
    title: '#F2EEFA',
    text: '#A9A1BD',
    faint: '#6F6885',
    glowOpacity: 0.3,
    style: SCREEN_STYLE,
  },
  {
    id: 'deep_sea',
    name: 'Deep Sea',
    backgroundTop: '#05131B',
    backgroundBottom: '#0B2633',
    title: '#EAF4F6',
    text: '#9DB8C2',
    faint: '#5F7C88',
    glowOpacity: 0.26,
    style: {
      edge: '#86BFD0',
      edgeHighlight: '#EAF4F6',
      label: '#EAF4F6',
      labelSecondary: '#9DB8C2',
      labelOutline: '#05131B',
      selection: '#EAF4F6',
      glow: '#3FA7C4',
      roleColors: {
        ARTIST: '#F3F7F8',
        PRODUCER: '#5CE0C6',
        SONGWRITER: '#FFC56B',
        MUSICIAN: '#6FB6FF',
        OTHER: '#5F7C88',
      },
      labelFont: SANS,
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    backgroundTop: '#F6F2EA',
    backgroundBottom: '#EDE7DB',
    title: '#1E1B26',
    text: '#5B5568',
    faint: '#8E8899',
    glowOpacity: 0.1,
    style: {
      edge: '#6E6880',
      edgeHighlight: '#1E1B26',
      label: '#1E1B26',
      labelSecondary: '#5B5568',
      labelOutline: '#F6F2EA',
      selection: '#1E1B26',
      glow: '#8E7CC8',
      roleColors: {
        ARTIST: '#6B4FD8',
        PRODUCER: '#168F7B',
        SONGWRITER: '#C97F12',
        MUSICIAN: '#2C68CF',
        OTHER: '#8E8899',
      },
      labelFont: SANS,
    },
  },
];
