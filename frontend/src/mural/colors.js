import { MURAL_COLORS } from '../../../shared/mural.js'

const accents = {
  neutral: 'var(--ayame-text-muted)',
  lavender: 'var(--ayame-primary)',
  fern: 'var(--ayame-success-accent)',
  ochre: 'var(--ayame-warning)',
  blue: 'var(--ayame-info)',
  rose: 'var(--ayame-error)',
}

export const muralColors = MURAL_COLORS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), accent: accents[id] }))
export const muralAccent = (color) => accents[color] ?? accents.neutral
