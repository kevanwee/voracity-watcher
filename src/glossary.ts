// Known English names for common Japanese listing words. Names made only of these are
// translated instantly and exactly; anything else goes to the local model with these as
// hints. Add entries only when the official English name is certain.
export const GLOSSARY: Record<string, string> = {
  // Edition and rarity notes.
  'パラレル': 'Parallel',
  '特別仕様': 'Special Edition',
  'プロモ': 'Promo',
  '箔押し': 'Foil Stamped',
  'シークレット': 'Secret',
  'スーパーレア': 'Super Rare',
  // Digimon: the Royal Knights and other frequent names.
  'オメガモン': 'Omnimon',
  'アルファモン': 'Alphamon',
  'デュナスモン': 'Dynasmon',
  'ジエスモン': 'Jesmon',
  'マグナモン': 'Magnamon',
  'ガンクゥモン': 'Gankoomon',
  'クレニアムモン': 'Craniamon',
  'ドゥフトモン': 'Duftmon',
  'デュークモン': 'Gallantmon',
  'スレイプモン': 'Sleipmon',
  'エグザモン': 'Examon',
  'アルフォースブイドラモン': 'UlforceVeedramon',
  'ロイヤルナイツ': 'Royal Knights',
  'アグモン': 'Agumon',
  'ガブモン': 'Gabumon',
  'ドルモン': 'Dorumon',
  'インペリアルドラモン': 'Imperialdramon',
  'ロードナイトモン': 'Lordknightmon',
  'ギルモン': 'Guilmon',
  'グレイモン': 'Greymon',
  'メタルグレイモン': 'MetalGreymon',
  'ウォーグレイモン': 'WarGreymon',
  'ガルルモン': 'Garurumon',
  'メタルガルルモン': 'MetalGarurumon',
};

const KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
const JAPANESE = /[぀-ヿ㐀-鿿]/;

/** "Alphamon(Parallel)" → "Alphamon (Parallel)", full-width brackets to ASCII, spaces tidied. */
export function tidyName(name: string) {
  return name.replace(/（/g, '(').replace(/）/g, ')').replace(/／/g, '/').replace(/(\S)\(/g, '$1 (').replace(/\s+/g, ' ').trim();
}

/** The English name when the glossary covers every Japanese word in it, otherwise null. */
export function fromGlossary(name: string) {
  let out = name;
  for (const key of KEYS) out = out.split(key).join(GLOSSARY[key]);
  return JAPANESE.test(out) ? null : tidyName(out);
}

/** Glossary lines for the model's instructions. */
export const glossaryHints = () => Object.entries(GLOSSARY).map(([jp, en]) => `${jp} = ${en}`).join('; ');
