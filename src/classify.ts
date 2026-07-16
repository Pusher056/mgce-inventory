import type { Category } from './types'

/**
 * Categorize a beverage from its name/brand when no database category exists
 * (US wines/liquors are rarely in Open Food Facts, and UPCitemdb has no
 * categories). Order matters: mixers before water ("tonic water"), soft
 * before beer ("ginger ale"), water before sparkling ("sparkling water").
 */
export function categoryFromText(...parts: (string | null | undefined)[]): Category | null {
  const t = parts.filter(Boolean).join(' ').toLowerCase()
  if (!t) return null
  if (/cola|coke|pepsi|sprite|fanta|soda|juice|jugo|lemonade|iced tea|tonic|ginger ale|red bull|monster|gatorade|energy drink|nectar|punch/.test(t)) return 'soft'
  if (/water|agua|seltzer/.test(t)) return 'water'
  if (/champagne|prosecco|cava\b|sparkling|spumante|cr[eé]mant|brut\b|moscato d'asti/.test(t)) return 'sparkling'
  if (/\bros[eé]\b|rosado|provence/.test(t)) return 'rose_wine'
  if (/\bbeer\b|cerveza|lager|\bipa\b|stout|\bale\b|pilsner|corona|heineken|modelo\b/.test(t)) return 'beer'
  if (/cabernet|merlot|pinot noir|malbec|tempranillo|rioja|syrah|shiraz|zinfandel|chianti|\btinto\b|red wine|sangiovese|garnacha|bordeaux|burgundy/.test(t)) return 'red_wine'
  if (/chardonnay|sauvignon|pinot gri[gs]io?|riesling|moscato|albari[ñn]o|verdejo|\bblanco\b|white wine|gew[uü]rztraminer|viognier|chenin/.test(t)) return 'white_wine'
  if (/vodka|whisk|bourbon|tequila|mezcal|\brum\b|\bron\b|\bgin\b|cognac|brandy|liqueur|licor|scotch|aperol|campari|vermouth|vermut|baileys|kahl[uú]a|j[aä]ger|amaretto|triple sec|schnapps|soju|anejo|añejo|reposado|blanco tequila/.test(t)) return 'spirits'
  if (/\bwine\b|\bvino\b/.test(t)) return 'red_wine'
  return null
}
