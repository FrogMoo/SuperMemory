/** Decorative glyph for the SuperMemory sidebar panel row. */
import { createElement } from 'react'

/**
 * Render the SuperMemory mark at the size the sidebar asks for.
 * @param props - the sidebar's icon share: requested edge and active state.
 * @returns decorative inline SVG.
 */
export function SupermemoryIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = props.size ?? 18
  const stroke = props.active ? 'currentColor' : 'currentColor'
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke,
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    // layered "memory" arcs
    createElement('path', { key: 'a', d: 'M12 3a7 7 0 0 0-7 7c0 1.6.5 3 1.4 4.2L12 21l5.6-6.8A7 7 0 0 0 12 3z' }),
    createElement('path', { key: 'b', d: 'M9.5 10.5a2.5 2.5 0 1 1 3.4 2.33c-.78.35-1.4 1-1.4 1.92' }),
    createElement('circle', { key: 'c', cx: 11.5, cy: 16.4, r: 0.4, fill: stroke, stroke: 'none' }),
  )
}
