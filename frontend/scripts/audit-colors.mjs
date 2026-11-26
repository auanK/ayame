import { readFileSync } from 'node:fs'
import Color from 'colorjs.io'
import { APCAcontrast, fontLookupAPCA, sRGBtoY } from 'apca-w3'

const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8')
const tokens = Object.fromEntries(
  [...css.matchAll(/--([\w-]+): ([^;]+);/g)].map(([, name, value]) => [name, value]),
)

function resolveColor(value) {
  if (!value) throw new Error('Missing palette token')
  const variable = value.match(/^var\(--([\w-]+)\)$/)
  if (variable) return resolveColor(tokens[variable[1]])

  const mixture = value.match(/^color-mix\(in srgb, (.+) ([\d.]+)%, transparent\)$/)
  if (mixture) {
    const color = resolveColor(mixture[1])
    color.alpha *= Number(mixture[2]) / 100
    return color
  }
  const color = new Color(value).to('srgb')
  if (!color.inGamut('srgb')) throw new Error(`Color outside sRGB: ${value}`)
  return color
}

function composite(foreground, background) {
  return foreground.coords.map((value, index) => value * foreground.alpha + background[index] * (1 - foreground.alpha))
}

function luminance(rgb) {
  const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

const uiSurfaces = ['ayame-background', 'ayame-surface', 'ayame-surface-elevated', 'ayame-hover', 'ayame-input-bg']
const readingSurface = 'reading-background'
const tinted = (name, percent, background = readingSurface) => [
  `color-mix(in srgb, var(--${name}) ${percent}%, transparent)`,
  background,
]
const selectedNote = ['reading-selection-bg', readingSurface]
const selectedUi = ['ayame-selection', 'ayame-surface-elevated']
const activeUi = ['workspace-active', 'ayame-surface-elevated']

// Text uses 4.5:1. APCA is reported alongside WCAG with font guidance for key roles.
const textChecks = [
  ['Interface text', 'ayame-text', [...uiSurfaces, activeUi, selectedUi]],
  ['Muted labels', 'ayame-text-muted', [...uiSurfaces, activeUi]],
  ['Placeholders', 'ayame-placeholder', ['ayame-input-bg']],
  ['Primary action text', 'ayame-on-primary', ['ayame-primary-fill', 'ayame-primary-fill-hover']],
  ['Properties action text', 'ayame-on-primary', ['reading-action-fill', 'reading-action-fill-hover']],
  ['Links', 'ayame-link', [readingSurface, ...uiSurfaces]],
  ['Notes', 'reading-text', [readingSurface]],
  ['Selected note text', 'reading-text', [selectedNote]],
  ['Note headings', 'reading-heading', [readingSurface, selectedNote]],
  ['Syntax', 'reading-syntax', [readingSurface]],
  ['Note links', 'reading-link', [readingSurface, ['reading-link-hover-bg', readingSurface]]],
  ['Visited note links', 'reading-link-visited', [readingSurface]],
  ['Hovered note links', 'reading-link-hover', [readingSurface, ['reading-link-hover-bg', readingSurface]]],
  ['Unresolved links', 'ayame-link-unresolved', [readingSurface]],
  ['Warnings and ambiguous links', 'ayame-warning', [...uiSurfaces, readingSurface, tinted('ayame-warning', 10)]],
  ['Tags', 'reading-tag-text', ['reading-tag-bg', activeUi]],
  ['Code', 'reading-code-text', ['reading-code-bg', ['reading-code-inline-bg', readingSurface]]],
  ['Quotes', 'reading-blockquote-text', [['reading-blockquote-bg', readingSurface]]],
  ['Success', 'ayame-success', [readingSurface, tinted('ayame-success-accent', 10, 'ayame-surface-elevated')]],
  ['Success hint', 'ayame-success-accent', ['ayame-surface', tinted('ayame-success-accent', 7)]],
  ['Information', 'ayame-info', [tinted('ayame-info', 7)]],
  ['Error', 'ayame-error', [...uiSurfaces, ['ayame-error-bg', 'ayame-surface-elevated'], tinted('ayame-error', 8)]],
  ['Conflict', 'ayame-conflict', [tinted('ayame-conflict-tint', 25, 'ayame-surface-elevated')]],
  ['Graph labels', tinted('graph-label', 72, 'ayame-background'), ['ayame-background']],
]

// Identifying borders, focus and information-carrying graph marks use 3:1.
const nonTextChecks = [
  ['Control boundary', 'ayame-control-border', [...uiSurfaces, readingSurface]],
  ['Focus or selection indicator', 'ayame-focus', [...uiSurfaces, readingSurface, activeUi]],
  ['Pane splitter handle', 'ayame-control-border', ['ayame-surface', readingSurface]],
  ['Reading controls', 'reading-control-border', ['reading-control-bg', readingSurface]],
  ['Checklist checkmark', 'reading-on-checkbox', ['reading-accent']],
  ...['graph-edge', 'graph-tag-edge', 'graph-node', 'graph-tag', 'graph-tag-focus'].map(
    (token) => [token, token, ['ayame-background']],
  ),
]

const typography = {
  'Notes': 400,
  'Primary action text': 600,
  'Graph labels': 400,
}

function measure(text, backdrop) {
  const resolve = (token) => resolveColor(tokens[token] ?? token)
  const getRgb = (value) => Array.isArray(value)
    ? composite(resolve(value[0]), getRgb(value[1]))
    : resolve(value).coords

  const background = getRgb(backdrop)
  const foreground = Array.isArray(text) ? getRgb(text) : composite(resolve(text), background)
  const [darker, lighter] = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return {
    ratio: (lighter + 0.05) / (darker + 0.05),
    lc: APCAcontrast(sRGBtoY(foreground.map((v) => v * 255)), sRGBtoY(background.map((v) => v * 255))),
  }
}

for (const value of Object.values(tokens)) resolveColor(value)

console.log('Lowest WCAG ratio per role, with APCA reference for text')
const checks = [...textChecks.map((row) => [...row, 4.5]), ...nonTextChecks.map((row) => [...row, 3])]
for (const [label, text, surfaces, minimum] of checks) {
  const results = surfaces.map((surface) => measure(text, surface))
  const ratio = Math.min(...results.map(({ ratio }) => ratio))
  const { lc } = results.reduce((lowest, next) => Math.abs(next.lc) < Math.abs(lowest.lc) ? next : lowest)
  const weight = typography[label]
  const minSize = weight ? fontLookupAPCA(lc)[weight / 100] : null
  const failed = ratio < minimum
  const apca = minimum === 4.5 ? `  Lc ${lc.toFixed(1)}` : ''
  const lookup = weight ? `  (APCA reference at weight ${weight}: ${minSize}px)` : ''
  console.log(`${failed ? 'FAIL' : 'PASS'}  ${label.padEnd(33)} ${ratio.toFixed(2)}:1${apca}${lookup}`)
  if (failed) process.exitCode = 1
}
