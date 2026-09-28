/* Guardian Sketch — strings for the Graphics settings section (ES module).
 * The rest of the game ships in English; these controls follow the browser
 * language (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT).
 */

const EN = {
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  fromPreset: 'From preset ({tier})',
  renderScale: 'Render scale',
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the game renders without it.',
  unknownGpu: 'unknown GPU',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Surface detail',
    particles: 'Particles', background: 'Ambient motion'
  },
  tier: {
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium',
    off: 'Off', on: 'On', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Plain', detailed: 'Detailed', static: 'Still', animated: 'Animated'
  }
};

const GB = Object.assign({}, EN, { cat: Object.assign({}, EN.cat, { grade: 'Colour grade' }) });

const ES = {
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  fromPreset: 'Del ajuste ({tier})',
  renderScale: 'Escala de renderizado',
  adaptive: 'Resolución adaptativa',
  showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
  unknownGpu: 'GPU desconocida',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
    antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de superficies',
    particles: 'Partículas', background: 'Movimiento ambiental'
  },
  tier: {
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
    off: 'No', on: 'Sí', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Detallado', static: 'Quieto', animated: 'Animado'
  }
};
const ES419 = Object.assign({}, ES, { showFps: 'Mostrar cuadros por segundo' });

const DE = {
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  fromPreset: 'Aus Voreinstellung ({tier})',
  renderScale: 'Renderskalierung',
  adaptive: 'Adaptive Auflösung',
  showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
  unknownGpu: 'unbekannte GPU',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Oberflächendetails',
    particles: 'Partikel', background: 'Umgebungsbewegung'
  },
  tier: {
    low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel',
    off: 'Aus', on: 'An', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Einfach', detailed: 'Detailliert', static: 'Ruhig', animated: 'Animiert'
  }
};

const FR = {
  quality: 'Qualité',
  auto: 'Automatique (détectée : {tier})',
  fromPreset: 'Selon le préréglage ({tier})',
  renderScale: 'Échelle de rendu',
  adaptive: 'Résolution adaptative',
  showFps: 'Afficher la fréquence d’images',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans lui.',
  unknownGpu: 'GPU inconnu',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des surfaces',
    particles: 'Particules', background: 'Mouvement d’ambiance'
  },
  tier: {
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne',
    off: 'Non', on: 'Oui', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Détaillé', static: 'Immobile', animated: 'Animé'
  }
};
const FRCA = Object.assign({}, FR, { showFps: 'Afficher le nombre d’images par seconde' });

const PT = {
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  fromPreset: 'Da predefinição ({tier})',
  renderScale: 'Escala de renderização',
  adaptive: 'Resolução adaptativa',
  showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
  unknownGpu: 'GPU desconhecida',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor',
    antialias: 'Antisserrilhado', reflections: 'Reflexos', detail: 'Detalhe das superfícies',
    particles: 'Partículas', background: 'Movimento ambiente'
  },
  tier: {
    low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média',
    off: 'Não', on: 'Sim', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simples', detailed: 'Detalhado', static: 'Parado', animated: 'Animado'
  }
};

const IT = {
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  fromPreset: 'Dal preset ({tier})',
  renderScale: 'Scala di rendering',
  adaptive: 'Risoluzione adattiva',
  showFps: 'Mostra frequenza fotogrammi',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
  unknownGpu: 'GPU sconosciuta',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
    antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio superfici',
    particles: 'Particelle', background: 'Movimento ambientale'
  },
  tier: {
    low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media',
    off: 'No', on: 'Sì', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Semplice', detailed: 'Dettagliato', static: 'Fermo', animated: 'Animato'
  }
};

export const LOCALES = {
  'en-US': EN, 'en-GB': GB, 'es-419': ES419, 'es-ES': ES, 'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FRCA, 'pt-BR': PT, 'it-IT': IT
};

/** Best supported locale for a BCP 47 tag (exact, then language fallback). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  if (LOCALES[t]) return t;
  const lang = t.split('-')[0].toLowerCase();
  const region = (t.split('-')[1] || '').toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

function browserLocale() {
  try { return (navigator.languages && navigator.languages[0]) || navigator.language; } catch (e) { return 'en-US'; }
}

/** Strings for the given (or browser) locale. */
export function gfxStrings(tag) {
  return LOCALES[pickLocale(tag || (typeof navigator !== 'undefined' ? browserLocale() : 'en-US'))];
}

export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? vars[k] : ''; });
}
