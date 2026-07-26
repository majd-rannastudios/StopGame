export type UILang = "en" | "fr" | "ar";

export const STR: Record<string, Record<UILang, string>> = {
  tagline:      { en: "the letter race", fr: "la course aux lettres", ar: "سباق الحروف" },
  yourName:     { en: "Your name", fr: "Ton prénom", ar: "اسمك" },
  createRoom:   { en: "Play with friends", fr: "Jouer entre amis", ar: "العب مع الأصدقاء" },
  quickMatch:   { en: "Quick match", fr: "Partie rapide", ar: "مباراة سريعة" },
  soloPlay:     { en: "Solo — beat the clock", fr: "Solo — contre la montre", ar: "فردي — تحدَّ الوقت" },
  soloDone:     { en: "Final score", fr: "Score final", ar: "النتيجة النهائية" },
  soloAgain:    { en: "Play again", fr: "Rejouer", ar: "العب مرة أخرى" },
  soloNoRivals: { en: "Just you and the timer", fr: "Toi et le chrono", ar: "أنت والوقت فقط" },
  joinCode:     { en: "Join with code", fr: "Rejoindre avec un code", ar: "انضم برمز" },
  code:         { en: "CODE", fr: "CODE", ar: "الرمز" },
  waiting:      { en: "Waiting for players…", fr: "En attente de joueurs…", ar: "بانتظار اللاعبين…" },
  ready:        { en: "Ready", fr: "Prêt", ar: "جاهز" },
  start:        { en: "Start", fr: "Démarrer", ar: "ابدأ" },
  host:         { en: "Host", fr: "Hôte", ar: "المضيف" },
  round:        { en: "Round", fr: "Manche", ar: "الجولة" },
  stop:         { en: "STOP!", fr: "STOP !", ar: "!ستوب" },
  called:       { en: "called STOP", fr: "a dit STOP", ar: "ضغط ستوب" },
  timeUp:       { en: "Time's up!", fr: "Temps écoulé !", ar: "!انتهى الوقت" },
  startsWith:   { en: "starts with", fr: "commence par", ar: "يبدأ بحرف" },
  invalid:      { en: "invalid", fr: "invalide", ar: "غير صالح" },
  challenge:    { en: "Put it to a vote", fr: "Mettre au vote", ar: "اعرضها للتصويت" },
  voteQ:        { en: "Is this a valid answer?", fr: "Réponse valide ?", ar: "هل هذه الإجابة صحيحة؟" },
  voteValid:    { en: "Valid", fr: "Valide", ar: "صحيحة" },
  voteInvalid:  { en: "Not valid", fr: "Invalide", ar: "خاطئة" },
  scoreboard:   { en: "Scoreboard", fr: "Classement", ar: "النتائج" },
  winner:       { en: "Winner", fr: "Vainqueur", ar: "الفائز" },
  nextRound:    { en: "Next round", fr: "Manche suivante", ar: "الجولة التالية" },
  playAgain:    { en: "Play again", fr: "Rejouer", ar: "العب مرة أخرى" },
  leave:        { en: "Leave", fr: "Quitter", ar: "مغادرة" },
  waitingOthers: { en: "Waiting for the others…", fr: "En attente des autres…", ar: "بانتظار الآخرين…" },
  share:        { en: "Copy invite", fr: "Copier l'invitation", ar: "نسخ الدعوة" },
  copied:       { en: "Copied!", fr: "Copié !", ar: "!تم النسخ" },
  fairV:        { en: "verified fair", fr: "équité vérifiée", ar: "عشوائية موثقة" },
  needMorePlayers: { en: "Need at least 2 players", fr: "Il faut au moins 2 joueurs", ar: "تحتاج لاعبين اثنين على الأقل" },
  fillAllFirst: { en: "Fill every category first!", fr: "Remplis toutes les catégories !", ar: "!املأ كل الفئات أولاً" },
  noFlagsLeft:  { en: "No votes left this round", fr: "Plus de votes cette manche", ar: "لا مزيد من التصويتات" },
  alreadyReviewed: { en: "Already decided", fr: "Déjà tranché", ar: "تم البت فيها" },
  connError:    { en: "Connection lost", fr: "Connexion perdue", ar: "انقطع الاتصال" },

  /* --- writing screen --- */
  rounds:       { en: "Rounds", fr: "Manches", ar: "الجولات" },
  difficulty:   { en: "Letters", fr: "Lettres", ar: "الحروف" },
  easy:         { en: "Easy", fr: "Facile", ar: "سهل" },
  hard:         { en: "All", fr: "Toutes", ar: "الكل" },
  seconds:      { en: "Time", fr: "Temps", ar: "الوقت" },
  filled:       { en: "filled", fr: "remplies", ar: "مكتملة" },
  fillAllToStop: { en: "Fill all 6 to call STOP", fr: "Remplis les 6 pour STOP", ar: "املأ الستة لتضغط ستوب" },
  mustStart:    { en: "must start with", fr: "doit commencer par", ar: "يجب أن يبدأ بـ" },
  sameTwice:    { en: "you already used that", fr: "déjà utilisé", ar: "استخدمتها بالفعل" },

  /* --- checking / reveal --- */
  checking:     { en: "Checking answers…", fr: "Vérification…", ar: "…جارٍ التحقق" },
  aiRef:        { en: "AI referee", fr: "arbitre IA", ar: "حكم ذكي" },
  validBadge:   { en: "Valid", fr: "Valide", ar: "صحيحة" },
  unique:       { en: "Only one!", fr: "Unique !", ar: "!فريدة" },
  duplicate:    { en: "Shared", fr: "Partagé", ar: "مكررة" },
  blank:        { en: "Blank", fr: "Vide", ar: "فارغة" },
  underReview:  { en: "To the table", fr: "Au vote", ar: "للتصويت" },
  roundTotal:   { en: "this round", fr: "cette manche", ar: "هذه الجولة" },

  /* --- table vote --- */
  tableVote:    { en: "Table vote", fr: "Vote de table", ar: "تصويت اللاعبين" },
  aiUnsureHdr:  { en: "The AI can't confirm this one", fr: "L'IA ne peut pas confirmer", ar: "الذكاء الاصطناعي غير متأكد" },
  peerFlagHdr:  { en: "A player questioned this", fr: "Un joueur conteste", ar: "لاعب اعترض" },
  yourAnswer:   { en: "Your answer — the others decide", fr: "Ta réponse — les autres décident", ar: "إجابتك — الآخرون يقررون" },
  votesIn:      { en: "votes in", fr: "votes", ar: "صوت" },
  accepted:     { en: "Accepted", fr: "Acceptée", ar: "قُبلت" },
  rejected:     { en: "Rejected", fr: "Rejetée", ar: "رُفضت" },
  moreQueued:   { en: "more to review", fr: "autres à revoir", ar: "أخرى للمراجعة" },

  /* --- verdict reasons, keyed by the server's "@" codes --- */
  "@wrongLetter":   { en: "wrong letter", fr: "mauvaise lettre", ar: "حرف خاطئ" },
  "@notAWord":      { en: "not a real word", fr: "pas un vrai mot", ar: "ليست كلمة حقيقية" },
  "@tooLong":       { en: "too long", fr: "trop long", ar: "طويلة جدًا" },
  "@oneWordOnly":   { en: "one word only", fr: "un seul mot", ar: "كلمة واحدة فقط" },
  "@aiUnsure":      { en: "the AI wasn't sure", fr: "l'IA n'était pas sûre", ar: "الذكاء الاصطناعي غير متأكد" },
  "@peerFlag":      { en: "questioned by a player", fr: "contesté par un joueur", ar: "اعترض عليها لاعب" },
  "@tableAccepted": { en: "the table said yes", fr: "la table a dit oui", ar: "وافق اللاعبون" },
  "@tableRejected": { en: "the table said no", fr: "la table a dit non", ar: "رفضها اللاعبون" },
};

export const t = (key: string, lang: UILang) => STR[key]?.[lang] ?? STR[key]?.en ?? key;
export const isRTL = (lang: UILang) => lang === "ar";

/** Verdict reasons are either an "@key" the client translates or free text from the referee. */
export const reasonText = (reason: string | undefined, lang: UILang): string =>
  !reason ? "" : reason.startsWith("@") ? t(reason, lang) : reason;
