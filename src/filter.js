// Local safety filter: blocks politics / religion / sexual / insults before and after the model.
const DIAC = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
export function normalize(s = '') {
  return String(s).toLowerCase().replace(DIAC, '')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/(.)\1{2,}/g, '$1$1') // سكككس -> سكس-ish
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Whole-word matches (after stripping Arabic prefixes). Normalized spelling.
const WORDS = {
  politics: ['سياسه','سياسي','سياسيه','السياسه','حكومه','حكومات','انتخابات','انتخاب','برلمان','حزب','احزاب','رئيس الدوله','ترامب','بايدن','نتنياهو','اسرائيل','صهيوني','صهاينه','فلسطين','غزه','ايران','حماس','حزب الله','الحوثي','حوثي','داعش','ارهاب','ارهابي','مظاهره','ثوره','انقلاب','وزير','وزاره','حرب','الحرب','حروب','قصف','معارضه','ولي العهد','الملك سلمان','بن سلمان','ابن سلمان','احتلال','يهود','اليهود',
             'حكام','الحكام','حاكم','الحاكم','زعيم','رييس','الرييس','politics','political','election','elections','government','president','trump','biden','israel','palestine','gaza','iran','hamas','war','zionist','terrorist','democrat','republican'],
  religion: ['الدين','دينك','ديني','دينه','اديان','الاديان','مذهب','مذاهب','مذهبك','طايفه','طايفي','شيعه','شيعي','السنه والشيعه','فتوي','فتاوي','افتني','حرام ولا حلال','شرعا','شرعي','الشرع','كافر','كفار','كفر','ملحد','الحاد','مسيحي','مسيحيه','نصراني','يهودي','بوذي','هندوسي','اسلام','الاسلام','مسلم ولا','الرسول','القران','قران','الانجيل','التوراه','بدعه','شرك','مشرك','جنه ونار','النار والجنه','صوفي','سلفي','وهابي','تكفير','الاخوان المسلمين',
             'religion','religious','islam','muslim','christian','jew','jewish','atheist','allah','fatwa','haram','halal','bible','quran','church','mosque'],
  sexual: ['سكس','جنس','الجنس','جنسي','نيك','نيكني','زب','زبي','طيز','بزاز','كس','كسك','عاري','عاريه','عري','شهوه','شهواني','اغراء','بوسني','بوسه','نام معي','نامي معي','تنامين معي','تنامي معي','نامي جنبي','بوسيني','حبيبتي تعالي','بورن','اباحي','اباحيه','لحس','قحبه','شرموط','شرموطه','منيوك','عاهره','دعاره','مثلي','شاذ',
             'sex','sexy','porn','nude','nudes','naked','xxx','boobs','tits','dick','pussy','horny','onlyfans','nsfw','kiss me','hot girl'],
  insults: ['يلعن','لعنه','الله يلعن','تفو','تف عليك','يا حمار','يا كلب','يا حيوان','يا غبي','حقير','وسخ','زق','خرا','خره','ابن الكلب','عنصري','زنجي','ياخي اسكت','انقلع','انطم','اخرسي','اخرس','قبيحه','بشعه','دبه','fuck','fucking','shit','bitch','idiot','stupid','ugly','loser','nigger','nigga','retard','kill yourself','kys'],
};
// Substring stems (catch conjugations); kept narrow to avoid false positives.
const STEMS = {
  politics: ['سياس','انتخاب','حكوم','برلمان','اسرايل','اسرائيل','صهيون','ارهاب','politic','election'],
  religion: ['فتوي','فتاو','مذهب','طايف','ملحد','تكفير','religio','atheis'],
  sexual: ['سكس','اباح','شرموط','منيوك','قحب','porn','sex','nude','fuck'],
  insults: ['شرموط','يلعن','عنصري','fuck','bitch'],
};
const PREFIXES = ['وال','بال','فال','لل','ال','و','ب','ف','ل','ك'];

function tokens(norm) {
  const out = new Set();
  for (const w of norm.split(' ')) {
    if (!w) continue;
    out.add(w);
    for (const p of PREFIXES) if (w.startsWith(p) && w.length - p.length >= 2) out.add(w.slice(p.length));
  }
  return out;
}

export function checkText(text) {
  const norm = normalize(text);
  if (!norm) return null;
  const toks = tokens(norm);
  const padded = ` ${norm} `;
  for (const [cat, list] of Object.entries(WORDS)) {
    for (const w of list) {
      const nw = normalize(w);
      if (nw.includes(' ') ? padded.includes(` ${nw} `) : toks.has(nw)) return { category: cat, hit: w };
    }
  }
  for (const [cat, list] of Object.entries(STEMS)) {
    for (const s of list) if (norm.includes(normalize(s))) return { category: cat, hit: s };
  }
  return null;
}

const DEFLECT = [
  'هههه هالسالفة مو جوّنا! تعال نتكلم في شي يفرّح: وش أحلى شي صار لك اليوم؟',
  'هذي السالفة تطفي جوي! بدّلها بشي حلو، مثلاً: قهوتك اليوم كيف كانت؟',
  'أوه، هالموضوع أكبر من شرارتي! خلّنا في الوناسة، عطني نكتة وأنا أسمع.',
  'لا لا، هالسالفة تخليني أنطفي! قول لي وش أكلتك المفضلة بدالها؟',
  'هههه خلّنا نبعد عن هالسوالف، البث هنا للضحك بس! مين عنده نكتة؟',
  'يا سلام عليك بس هالموضوع مو لنا! وش رايك نسوي تحدي ضحك بدالها؟',
];
let di = Math.floor(Math.random() * DEFLECT.length);
export function deflection() { di = (di + 1) % DEFLECT.length; return DEFLECT[di]; }

const SAFE_NAME = 'يا الغالي';
export function safeName(name) {
  if (!name) return '';
  const raw = String(name).replace(/\s/g, '');
  let n = String(name).replace(/[^\p{Script=Arabic}A-Za-z0-9 _.-]/gu, '').replace(/[_.\-]+/g, ' ').trim().slice(0, 20);
  // unreadable (emoji/other scripts/too few letters) -> generic, so TTS doesn't stumble
  const letters = (n.match(/[\p{Script=Arabic}A-Za-z]/gu) || []).length;
  if (letters < 3 || letters < [...raw].length * 0.6) return SAFE_NAME;
  return checkText(n) ? SAFE_NAME : n;
}
