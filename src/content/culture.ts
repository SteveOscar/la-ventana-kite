// Text content: characters, phrases and local knowledge. Characters are fictional;
// places, wind, wildlife and food are real.

export interface Character {
  id: string;
  name: string;
  role: string;
  color: string;
  initial: string;
}

export const CHARACTERS: Record<string, Character> = {
  memo: { id: 'memo', name: 'Memo', role: 'Kite instructor, El Sargento', color: '#2ec4b6', initial: 'M' },
  chuy: { id: 'chuy', name: 'Don Chuy', role: 'Panguero (fisherman)', color: '#e76f51', initial: 'C' },
  lupe: { id: 'lupe', name: 'Doña Lupe', role: 'Taquería on the beach', color: '#f4a261', initial: 'L' },
  rafa: { id: 'rafa', name: 'Rafa', role: 'Race director, La Ventana Classic', color: '#8a5cf6', initial: 'R' },
};

export interface Line {
  who: keyof typeof CHARACTERS;
  es: string;
  en: string;
}

/** Spanish exclamations for landings, by how good it was. */
export const CHEERS = {
  big: ['¡Órale!', '¡Qué padre!', '¡Ándale!', '¡Eso, eso, eso!', '¡Chido!', '¡Qué salto!'],
  clean: ['¡Eso!', '¡Bien!', '¡Limpio!', '¡Buena!', '¡Así se hace!'],
  hard: ['¡Uf!', 'Aterrizaje duro', '¡Casi!'],
  crash: ['¡Híjole!', '¡Ay, caray!', '¡Uy!', '¡Revolcón!'],
};

export const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)];

export const FUN_FACTS: { es: string; en: string }[] = [
  {
    es: 'El Norte sopla de noviembre a marzo.',
    en: 'El Norte is the winter north wind that funnels down the Sea of Cortez from roughly November to March. The channel between Isla Cerralvo and the mainland squeezes it, and the afternoon thermal adds a few knots.',
  },
  {
    es: '¿Cerralvo o Jacques Cousteau?',
    en: 'Isla Cerralvo was officially renamed Isla Jacques Cousteau in 2009, but almost everyone in La Ventana and El Sargento still calls it Cerralvo.',
  },
  {
    es: 'De El Sargento a La Ventana',
    en: 'The beach runs about 10 km (six miles) from El Sargento in the north to La Ventana in the south. With the wind from the north, that makes a classic downwinder.',
  },
  {
    es: 'Aguas termales en la playa',
    en: 'At the "Hot Springs" beach near El Sargento, dig into the sand at the waterline and you hit hot water. It is a favourite place to start a downwinder.',
  },
  {
    es: 'La Ventana Classic',
    en: 'The La Ventana Classic, a windsports festival held each January, raises money for the schools of La Ventana and El Sargento.',
  },
  {
    es: 'Las mobulas saltan',
    en: 'Mobula rays gather in La Ventana Bay in late spring (about April to July) and leap clear of the water. A jumping mobula is usually the first sign a school is near.',
  },
  {
    es: 'Ballenas en el Mar de Cortés',
    en: 'Humpback whales pass through the Sea of Cortez from about December to April. Bryde\'s whales live here all year.',
  },
  {
    es: 'El cardón',
    en: 'The cardón (Pachycereus pringlei) of the Baja hills is the tallest cactus species on Earth. Old ones are hundreds of years old and taller than a three-storey house.',
  },
  {
    es: 'La panga',
    en: 'The panga, an open fibreglass skiff with an outboard, is the workhorse of every Baja fishing village. Fishermen launch them straight off the beach.',
  },
  {
    es: 'Derecho de paso',
    en: 'Right of way: the rider on starboard tack (right hand forward) has right of way. When passing, the upwind rider keeps the kite high and the downwind rider keeps it low.',
  },
  {
    es: 'Elige tu cometa',
    en: 'For a 75 kg rider, a rough guide is a 12 m kite for 12-16 knots, a 9 m for 16-22 and a 7 m for 22-30. Too big and the gusts will drag you; too small and you will sink.',
  },
  {
    es: 'Lee el agua',
    en: 'Gusts show on the water before they reach you as darker, rougher patches, the "cat\'s paws". Lulls look smooth and pale.',
  },
  {
    es: 'Norte y Coromuel',
    en: 'La Paz is famous for the Coromuel, a cooling southerly breeze on spring and summer afternoons. Over the hill in La Ventana, the winter Norte is what built the kite scene.',
  },
  {
    es: 'Tacos de pescado',
    en: 'Baja fish tacos: battered fish on a corn tortilla with shredded cabbage, crema, salsa and a squeeze of lime.',
  },
  {
    es: 'Almejas chocolatas',
    en: 'Chocolate clams (almejas chocolatas), named for their brown shells, are a Baja California Sur favourite, eaten raw with lime or roasted on the beach.',
  },
  {
    es: 'Fogata al atardecer',
    en: 'After the session, the wind drops with the sun and people gather around beach fires as Cerralvo turns pink.',
  },
  {
    es: 'Hora de Baja Sur',
    en: 'Baja California Sur keeps Mountain Standard Time (UTC-7) all year, so the winter sun sets early, behind the sierra.',
  },
  {
    es: 'Perlas de La Paz',
    en: 'La Paz, about an hour away over the sierra, was famous for centuries for the pearls of its bay.',
  },
];

export interface Species {
  id: string;
  es: string;
  en: string;
  note: string;
  season: 'all' | 'winter' | 'spring';
}

export const SPECIES: Species[] = [
  { id: 'pelican', es: 'Pelícano café', en: 'Brown pelican', note: 'Flies in low lines over the chop, then folds and plunges for fish.', season: 'all' },
  { id: 'frigate', es: 'Fragata', en: 'Magnificent frigatebird', note: 'Soars for hours on the wind without flapping. Steals other birds\' catch.', season: 'all' },
  { id: 'dolphin', es: 'Delfines', en: 'Dolphins', note: 'Pods often cruise the channel between Cerralvo and the coast.', season: 'all' },
  { id: 'humpback', es: 'Ballena jorobada', en: 'Humpback whale', note: 'Passes through the Sea of Cortez from about December to April. Watch for the blow.', season: 'winter' },
  { id: 'sealion', es: 'Lobo marino', en: 'California sea lion', note: 'Breeding colonies on islands north of La Paz. Strays hunt in the bay.', season: 'all' },
  { id: 'turtle', es: 'Tortuga marina', en: 'Sea turtle', note: 'Pops its head up to breathe. Give it room.', season: 'all' },
  { id: 'mobula', es: 'Mobulas', en: 'Mobula rays', note: 'Late-spring visitors (April to July) that leap clear of the water.', season: 'spring' },
  { id: 'osprey', es: 'Águila pescadora', en: 'Osprey', note: 'Hovers over the shallows and hits the water feet-first.', season: 'all' },
];

export interface Landmark {
  id: string;
  es: string;
  en: string;
  note: string;
}

export const LANDMARKS: Landmark[] = [
  { id: 'cerralvo', es: 'Isla Cerralvo', en: 'Cerralvo Island', note: 'Uninhabited desert island across the channel. Peak about 770 m.' },
  { id: 'hotSprings', es: 'Aguas termales', en: 'Hot Springs beach', note: 'Dig at the waterline for hot water. The classic downwinder start.' },
  { id: 'elSargento', es: 'El Sargento', en: 'El Sargento', note: 'The northern village: pangas on the beach, taquerías, a soccer pitch.' },
  { id: 'campground', es: 'El campamento', en: 'The campground', note: 'RVs, vans and tents of the winter kite crowd, right on the beach.' },
  { id: 'laVentana', es: 'La Ventana', en: 'La Ventana', note: 'The southern village where the bay curves east toward Punta Arenas.' },
];

export const TUTORIAL: { id: string; title: string; lines: Line[]; hint: string }[] = [
  {
    id: 'window',
    title: 'La ventana de viento · The wind window',
    lines: [
      { who: 'memo', es: '¡Bienvenido a La Ventana! Ya llegó el Norte.', en: 'Welcome to La Ventana! The Norte is here.' },
      {
        who: 'memo',
        es: 'Tu cometa vuela en una ventana frente a ti, a favor del viento.',
        en: 'Your kite flies in a "window" downwind of you. In the middle it pulls hard (the power zone); at the edges it pulls gently. Watch the gauge at the bottom left.',
      },
    ],
    hint: 'The kite is parked at 12 o\'clock. Press W to dive it into the power zone.',
  },
  {
    id: 'waterstart',
    title: 'Arranque · Waterstart',
    lines: [{ who: 'memo', es: 'Clava la cometa y levántate.', en: 'Dive the kite and let it pull you up onto the board.' }],
    hint: 'Hold W to dive the kite. A / D choose your direction before you go.',
  },
  {
    id: 'ride',
    title: 'Navegar · Ride',
    lines: [{ who: 'memo', es: '¡Eso! Ahora mantén la tabla de canto.', en: 'That\'s it! Keep your edge in and ride across the wind.' }],
    hint: 'Ride 300 m. A / D carve. W works the kite for more power, S depowers.',
  },
  {
    id: 'upwind',
    title: 'Ceñir · Stay upwind',
    lines: [
      {
        who: 'memo',
        es: 'Si no ciñes, terminas caminando por la playa.',
        en: 'If you don\'t hold your ground upwind, you end up doing the walk of shame down the beach. Point the board a little into the wind and keep your speed.',
      },
    ],
    hint: 'Reach the orange buoy upwind (north). Carve toward the wind, but not so far that you stall.',
  },
  {
    id: 'transition',
    title: 'Transición · Turn around',
    lines: [{ who: 'memo', es: 'Sube la cometa a las doce y gira.', en: 'Bring the kite up to 12, carve downwind through the turn, then dive it on the new side.' }],
    hint: 'Carve downwind (toward the kite) and keep turning until you ride the other way.',
  },
  {
    id: 'jump',
    title: 'Salto · Jump',
    lines: [
      {
        who: 'memo',
        es: 'Carga el canto, manda la cometa y ¡pop!',
        en: 'Load the edge, send the kite up, and pop. Release when the kite is swinging up through about 60 degrees.',
      },
    ],
    hint: 'Hold SPACE to edge and send the kite, release to pop. Land with the board pointing where you\'re going.',
  },
];

export const RACE_INTRO: Line[] = [
  {
    who: 'rafa',
    es: '¡Bienvenidos a La Ventana Classic!',
    en: 'Welcome to the La Ventana Classic! Every January this festival raises money for the schools of La Ventana and El Sargento.',
  },
  { who: 'rafa', es: 'Rodea las boyas: barlovento, sotavento, y a la meta.', en: 'Round the upwind buoy, then the downwind buoy, then the finish. Two laps. Buena suerte.' },
];

export const DOWNWINDER_INTRO: Line[] = [
  {
    who: 'chuy',
    es: 'Yo te sigo en la panga. Del termal hasta La Ventana.',
    en: 'I\'ll follow you in the panga. From the Hot Springs all the way down to La Ventana. Pass the flags and don\'t go out too far.',
  },
];

export const FREE_INTRO: Line[] = [
  { who: 'lupe', es: 'Cuando acabes, te guardo unos tacos de pescado.', en: 'When you\'re done, I\'ll save you some fish tacos.' },
];

export const DONE_LINES: Line[] = [
  { who: 'lupe', es: '¡Ven, ya están los tacos!', en: 'Come on, the tacos are ready!' },
  { who: 'chuy', es: 'Buen viento hoy, ¿eh?', en: 'Good wind today, huh?' },
  { who: 'memo', es: 'Mañana sopla otra vez. ¡Descansa!', en: 'It blows again tomorrow. Get some rest!' },
];

export const MONTHS = ['Noviembre', 'Diciembre', 'Enero', 'Febrero', 'Marzo', 'Abril'];
/** Day of year for the middle of each month above. */
export const MONTH_DAY = [319, 349, 15, 46, 74, 105];

export const POINT_OF_SAIL = (angleFromWind: number) => {
  const a = Math.abs(angleFromWind);
  if (a < 62) return { es: 'Ceñida', en: 'Upwind' };
  if (a < 105) return { es: 'Través', en: 'Beam reach' };
  if (a < 155) return { es: 'Largo', en: 'Broad reach' };
  return { es: 'Popa', en: 'Downwind' };
};
