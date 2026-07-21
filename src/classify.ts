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

/**
 * Subcategoría (tipo dentro de la categoría) desde el nombre/marca:
 * para spirits el tipo de licor (Tequila, Vodka, Bourbon…), para vinos la
 * uva/varietal (Riesling, Pinot Noir…). El equipo busca por estos términos,
 * y los packing lists usan el formato "Tipo: Marca" (p. ej. "Riesling: Rose Hill").
 * Devuelve el término en Title Case para agrupar y buscar consistente.
 */
export function subcategoryFromText(...parts: (string | null | undefined)[]): string | null {
  const t = parts.filter(Boolean).join(' ').toLowerCase()
  if (!t) return null

  // Los packing lists ponen el tipo antes de dos puntos: "Riesling: Rose Hill"
  const prefix = t.match(/^([a-zñáéíóú .'/-]{3,30}?):/)?.[1]?.trim()

  const RULES: [RegExp, string][] = [
    // Spirits
    [/tequila|espolon|patr[oó]n|don julio|casamigos|1800\b|herradura|cuervo/, 'Tequila'],
    [/mezcal|mescal/, 'Mezcal'],
    [/bourbon|makers mark|maker's|woodford|buffalo trace|bulleit bourbon|knob creek|four roses/, 'Bourbon'],
    [/scotch|johnnie walker|glenlivet|glenfiddich|macallan|chivas|dewar| balvenie/, 'Scotch'],
    [/\brye\b/, 'Rye'],
    [/irish whisk|jameson|tullamore/, 'Irish Whiskey'],
    [/whisk(e)?y|jack daniel|crown royal|bulleit/, 'Whiskey'],
    [/vodka|tito|grey goose|ketel|absolut|smirnoff|belvedere|ciroc/, 'Vodka'],
    [/\bgin\b|bombay|tanqueray|hendrick|beefeater/, 'Gin'],
    [/\brum\b|\bron\b|bacardi|captain morgan|malibu|diplomatico|zacapa/, 'Rum'],
    [/cognac|hennessy|r[eé]my|courvoisier|martell/, 'Cognac'],
    [/brandy|armagnac/, 'Brandy'],
    [/vermouth|vermut|martini rossi|dolin|carpano|noilly/, 'Vermouth'],
    [/aperol|campari|aperitif|aperitivo|lillet|st[- ]germain|cointreau|triple sec|grand marnier/, 'Aperitivo/Licor'],
    [/liqueur|licor|kahl[uú]a|baileys|amaretto|frangelico|chambord|schnapps|midori|drambuie/, 'Licor'],
    [/bitters|angostura/, 'Bitters'],
    // Sparkling
    [/champagne|lanson|veuve|mo[eë]t|dom p[eé]rignon|bollinger|taittinger|perrier[- ]jou[eë]t|laurent[- ]perrier|ruinart/, 'Champagne'],
    [/prosecco/, 'Prosecco'],
    [/cava\b/, 'Cava'],
    // Red wine varietals
    [/cabernet|banshee|iconoclast/, 'Cabernet Sauvignon'],
    [/pinot noir|chalk hill/, 'Pinot Noir'],
    [/merlot/, 'Merlot'],
    [/malbec/, 'Malbec'],
    [/syrah|shiraz/, 'Syrah'],
    [/zinfandel/, 'Zinfandel'],
    [/sangiovese|chianti|brunello/, 'Sangiovese'],
    [/tempranillo|rioja/, 'Tempranillo'],
    [/\bgarnacha|grenache\b/, 'Grenache'],
    // White wine varietals
    [/chardonnay|laroque|chalk hill chard/, 'Chardonnay'],
    [/sauv(ignon)? blanc|loveblock|sancerre/, 'Sauvignon Blanc'],
    [/pinot gri[gs]io?|grigio|gris/, 'Pinot Grigio'],
    [/riesling/, 'Riesling'],
    [/moscato|muscat/, 'Moscato'],
    [/gew[uü]rztraminer/, 'Gewürztraminer'],
    [/viognier/, 'Viognier'],
    [/albari[ñn]o/, 'Albariño'],
    [/chenin/, 'Chenin Blanc'],
    // Rosé
    [/proven[çc]e/, 'Provence Rosé'],
    // Beer
    [/\bipa\b/, 'IPA'],
    [/lager|pilsner|stella|heineken|amstel|corona|modelo|budweiser|miller/, 'Lager'],
    // Soft / water
    [/tonic/, 'Tónica'],
    [/club soda|soda water/, 'Club Soda'],
    [/ginger ale|ginger beer/, 'Ginger'],
    [/cola|coke|pepsi/, 'Cola'],
    [/sparkling water|seltzer|club soda|mineral water|agua mineral/, 'Agua con gas'],
  ]

  for (const [rx, label] of RULES) {
    if (rx.test(t)) return label
  }
  // Fall back to the packing-list prefix as-is, Title Cased
  if (prefix && prefix.length <= 22 && !/\d/.test(prefix)) {
    return prefix.replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return null
}

// Which top category a known subcategory (type/grape) belongs to. The
// subcategory classifier is reliable, so this is a stronger, self-consistent
// signal than the crude keyword category (avoids "Espolon Blanco" → white wine
// or brand "Rose Hill" → rosé).
const SUB_TO_CATEGORY: Record<string, Category> = {
  Tequila: 'spirits', Mezcal: 'spirits', Bourbon: 'spirits', Scotch: 'spirits',
  Rye: 'spirits', 'Irish Whiskey': 'spirits', Whiskey: 'spirits', Vodka: 'spirits',
  Gin: 'spirits', Rum: 'spirits', Cognac: 'spirits', Brandy: 'spirits',
  Vermouth: 'spirits', 'Aperitivo/Licor': 'spirits', Licor: 'spirits', Bitters: 'spirits',
  Champagne: 'sparkling', Prosecco: 'sparkling', Cava: 'sparkling',
  'Cabernet Sauvignon': 'red_wine', 'Pinot Noir': 'red_wine', Merlot: 'red_wine',
  Malbec: 'red_wine', Syrah: 'red_wine', Zinfandel: 'red_wine', Sangiovese: 'red_wine',
  Tempranillo: 'red_wine', Grenache: 'red_wine', 'Red Blend': 'red_wine',
  Chardonnay: 'white_wine', 'Sauvignon Blanc': 'white_wine', 'Pinot Grigio': 'white_wine',
  Riesling: 'white_wine', Moscato: 'white_wine', 'Gewürztraminer': 'white_wine',
  Viognier: 'white_wine', 'Albariño': 'white_wine', 'Chenin Blanc': 'white_wine',
  'White Blend': 'white_wine',
  'Provence Rosé': 'rose_wine', 'Rosé': 'rose_wine',
  IPA: 'beer', Lager: 'beer', Stout: 'beer', Pilsner: 'beer',
  'Tónica': 'soft', 'Club Soda': 'soft', Ginger: 'soft', Cola: 'soft',
  'Agua con gas': 'water', Still: 'water', Sparkling: 'water',
}

export function categoryForSubcategory(sub: string | null | undefined): Category | null {
  if (!sub) return null
  return SUB_TO_CATEGORY[sub] ?? null
}
