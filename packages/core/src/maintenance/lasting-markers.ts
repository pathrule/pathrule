// SPDX-License-Identifier: Apache-2.0
/**
 * The words a person uses when what they say is meant to last, per language. Data, not logic: the
 * stated-decision capture and the "as of writing" layout marker read this table, so a language is added
 * here and nowhere else. Phrases are lower case; matching lowercases the sentence. For a language whose
 * words take suffixes (Korean particles) the phrase matches as a prefix; for Japanese and Chinese there
 * are no word boundaries at all.
 *
 * Priority languages (owner, 2026-10-16): English, German, French, Spanish, Turkish, Italian, Japanese,
 * Brazilian Portuguese; then Dutch, Polish, Russian, Chinese, Korean. A phrase that is also an everyday
 * word ("always", "artık", "toujours") only counts in a sentence long enough to be a rule (see
 * `strongMinimum`), never on its own.
 */

export type Script = "spaced" | "cjk";

export interface LanguageMarkers {
  /** BCP 47 code. */
  code: string;
  script: Script;
  /** Whether a phrase must end at a word boundary. False for languages whose words take suffixes. */
  rightBoundary: boolean;
  /** Opens a decision: a new statement even right after another. */
  opener: string[];
  /** Among the openers, the ones that announce a changed decision. */
  changed: string[];
  /** Makes a sentence lasting on its own ("from now on"). */
  lasting: string[];
  /** A rule by its words alone, when the sentence is long enough ("always", "never", "must not"). */
  strong: string[];
  /** Words a quote begins with that are not what it says ("by the way", "also"). */
  leadIn: string[];
  /** Everyday turns of phrase that use a strong word without stating a rule ("as always"). */
  everyday: string[];
  /** Title prefixes for the memory a statement becomes. */
  titles: { decision: string; changed: string };
  /** Words that make an instruction sentence normative, so it stays binding in the rules file. */
  normative: string[];
  /** Verbs that say where something lives or how it is wired, for the layout marker. */
  layout: string[];
}

export const LASTING_MARKERS: readonly LanguageMarkers[] = [
  {
    code: "en",
    script: "spaced",
    rightBoundary: true,
    opener: ["team decision", "change of decision", "changed decision", "we decided", "we have decided", "we've decided", "decision:", "the team decided", "team decided", "decision is that", "the decision is", "decision from", "team call", "outcome of the"],
    changed: ["change of decision", "changed decision", "change of plan", "changed from", "switched to", "switched from", "is now * not", "no longer *, now"],
    lasting: ["from now on", "going forward", "as a rule", "new rule", "standing rule", "house rule", "from here on", "for every session", "keep in mind", "is legacy now", "considered deprecated", "is deprecated now", "is frozen"],
    strong: ["always", "never", "must never", "must always", "must not", "every new", "every time", "each new", "no * without", "nothing * without"],
    leadIn: ["by the way", "also", "and", "one more", "another", "note", "oh"],
    everyday: ["as always","as usual","like always","as ever","never mind","always been", "rule of thumb", "never got around", "never understood", "never worked"],
    titles: { decision: "Decision", changed: "Changed decision" },
    normative: ["never", "always", "must", "should", "do not", "don't", "only", "every", "each", "from now on", "going forward", "decided", "decision", "instead of", "prefer", "preferred", "required", "no longer", "not allowed", "forbidden", "no"],
    layout: ["lives", "live", "located", "sits", "sit", "resides", "reside", "is in", "are in", "is at", "are at", "is under", "are under", "holds", "hold", "contains", "contain", "defined in", "stored in", "is written", "writes", "reads", "generated from", "generates", "points at", "points to", "point at", "point to", "runs from", "runs with", "run from", "run with"],
  },
  {
    code: "de",
    script: "spaced",
    rightBoundary: true,
    opener: ["teamentscheidung", "team-entscheidung", "entscheidungsänderung", "geänderte entscheidung", "wir haben entschieden", "wir haben uns entschieden", "wir haben beschlossen", "entscheidung:", "im team beschlossen", "ist entschieden", "ergebnis vom", "ergebnis der", "entschieden:"],
    changed: ["entscheidungsänderung", "geänderte entscheidung", "neue entscheidung", "planänderung", "wechselt von", "gewechselt von", "ist jetzt * statt", "nicht mehr *, sondern"],
    lasting: ["ab jetzt", "ab sofort", "von nun an", "künftig", "zukünftig", "in zukunft", "grundsätzlich", "neue regel", "als regel", "von jetzt an", "merk dir", "merkt euch", "gilt als", "gelten als", "ist damit geschichte", "für alle unsere sessions"],
    strong: ["immer", "niemals", "darf nicht", "dürfen nicht", "muss immer", "müssen immer", "jede neue", "jedes neue", "jeder neue", "jedes mal", "kein * ohne", "keine * ohne", "geht kein", "nie wieder", "nie mehr", "nie ohne"],
    leadIn: ["übrigens", "außerdem", "und", "noch etwas", "noch eine sache", "nebenbei"],
    everyday: ["wie immer","wie üblich","wie gewohnt","nie und nimmer", "nie dazu gekommen", "nie verstanden"],
    titles: { decision: "Entscheidung", changed: "Geänderte Entscheidung" },
    normative: ["nie", "niemals", "immer", "muss", "müssen", "soll", "sollte", "nicht", "nur", "jede", "jeder", "jedes", "ab jetzt", "ab sofort", "künftig", "entschieden", "entscheidung", "statt", "anstatt", "anstelle", "bevorzugt", "erforderlich", "verboten", "kein", "keine"],
    layout: ["liegt in", "liegen in", "liegt unter", "befindet sich", "befinden sich", "steht in", "stehen in", "ist in", "sind in", "enthält", "enthalten", "definiert in", "gespeichert in", "schreibt", "liest", "erzeugt", "generiert", "zeigt auf", "läuft über", "wird aus"],
  },
  {
    code: "fr",
    script: "spaced",
    rightBoundary: true,
    opener: ["décision d'équipe", "décision de l'équipe", "changement de décision", "nous avons décidé", "on a décidé", "décision :", "décision:", "l'équipe a tranché", "l'équipe a décidé", "c'est acté", "sortie de la revue", "résultat de la revue", "décidé :", "décidé:"],
    changed: ["changement de décision", "nouvelle décision", "changement de cap", "changement de plan", "est passé de", "est passée de", "c'est maintenant * et non plus"],
    lasting: ["à partir de maintenant", "désormais", "dorénavant", "à l'avenir", "nouvelle règle", "pour règle", "à partir de là", "garde en tête", "retiens ça", "retenez ça", "pour toutes nos sessions", "considéré comme legacy", "sont dépréciées", "est gelé"],
    strong: ["toujours", "jamais", "ne doit jamais", "ne doit pas", "ne doivent pas", "doit toujours", "doivent toujours", "chaque nouveau", "chaque nouvelle", "à chaque fois", "chaque nouvel", "aucun * sans", "aucune * sans"],
    leadIn: ["au fait", "aussi", "et", "autre chose", "encore une chose", "d'ailleurs", "par ailleurs"],
    everyday: ["comme toujours","comme d'habitude","comme d'hab","jamais de la vie", "en règle générale", "jamais pris le temps", "jamais compris"],
    titles: { decision: "Décision", changed: "Décision modifiée" },
    normative: ["jamais", "toujours", "doit", "doivent", "devrait", "ne pas", "seulement", "uniquement", "chaque", "désormais", "dorénavant", "décidé", "décision", "au lieu de", "plutôt que", "préféré", "obligatoire", "interdit", "aucun", "aucune"],
    layout: ["se trouve dans", "se trouvent dans", "est dans", "sont dans", "est sous", "réside dans", "contient", "contiennent", "défini dans", "définie dans", "stocké dans", "stockée dans", "écrit", "lit", "généré à partir de", "génère", "pointe vers", "s'exécute depuis"],
  },
  {
    code: "es",
    script: "spaced",
    rightBoundary: true,
    opener: ["decisión del equipo", "decisión de equipo", "cambio de decisión", "decidimos", "hemos decidido", "decisión:", "el equipo decidió", "está decidido", "quedó decidido", "resultado de la revisión", "decidido:"],
    changed: ["cambio de decisión", "nueva decisión", "cambio de planes", "cambio de rumbo", "cambió de", "pasa de * a", "pasó de * a"],
    lasting: ["a partir de ahora", "de ahora en adelante", "desde ahora", "en adelante", "como regla", "nueva regla", "a partir de aquí", "ten en cuenta", "tenlo en cuenta", "en todas las sesiones", "queda como legado", "quedan obsoletas", "queda congelado"],
    strong: ["siempre", "nunca", "jamás", "no debe", "no deben", "nunca debe", "debe siempre", "deben siempre", "cada nuevo", "cada nueva", "cada vez", "todo * nuevo debe", "toda * nueva debe", "ningún * sin", "ninguna * sin"],
    leadIn: ["por cierto", "también", "y", "otra cosa", "una cosa más", "además"],
    everyday: ["como siempre","como de costumbre","como de costumbre", "por regla general", "nunca llegamos", "nunca entendí"],
    titles: { decision: "Decisión", changed: "Decisión cambiada" },
    normative: ["nunca", "jamás", "siempre", "debe", "deben", "debería", "no", "solo", "sólo", "únicamente", "cada", "a partir de ahora", "en adelante", "decidimos", "decisión", "en lugar de", "en vez de", "preferido", "obligatorio", "prohibido", "ningún", "ninguna"],
    layout: ["vive en", "viven en", "está en", "están en", "se encuentra en", "se encuentran en", "está bajo", "reside en", "contiene", "contienen", "definido en", "definida en", "guardado en", "almacenado en", "escribe", "lee", "generado desde", "genera", "apunta a", "se ejecuta desde"],
  },
  {
    code: "pt",
    script: "spaced",
    rightBoundary: true,
    opener: ["decisão do time", "decisão da equipe", "decisão de equipe", "mudança de decisão", "decidimos", "a gente decidiu", "decisão:", "o time decidiu", "a equipe decidiu", "ficou decidido", "está decidido", "saiu da revisão", "decidido:"],
    changed: ["mudança de decisão", "nova decisão", "mudança de rota", "mudança de planos", "mudou de", "sai do * e vai", "passou de * para", "passou de * pra"],
    lasting: ["a partir de agora", "daqui pra frente", "daqui para frente", "de agora em diante", "como regra", "nova regra", "daqui em diante", "guarda isso", "guarde isso", "todas as nossas sessões", "virou legado", "estão descontinuadas", "está congelado"],
    strong: ["sempre", "nunca", "jamais", "não deve", "não devem", "nunca deve", "deve sempre", "devem sempre", "cada novo", "cada nova", "todo novo", "toda nova", "toda vez", "todo * novo precisa", "toda * nova precisa", "nenhum * sem", "nenhuma * sem"],
    leadIn: ["aliás", "também", "e", "outra coisa", "mais uma coisa", "além disso"],
    everyday: ["como sempre","como de costume","como de hábito", "via de regra", "nunca conseguimos", "nunca entendi"],
    titles: { decision: "Decisão", changed: "Decisão alterada" },
    normative: ["nunca", "jamais", "sempre", "deve", "devem", "deveria", "não", "só", "somente", "apenas", "cada", "todo", "toda", "a partir de agora", "daqui pra frente", "decidimos", "decisão", "em vez de", "ao invés de", "preferido", "obrigatório", "proibido", "nenhum", "nenhuma"],
    layout: ["fica em", "ficam em", "está em", "estão em", "mora em", "está sob", "reside em", "contém", "definido em", "definida em", "salvo em", "armazenado em", "escreve", "lê", "gerado a partir de", "gera", "aponta para", "roda a partir de", "é executado de"],
  },
  {
    code: "it",
    script: "spaced",
    rightBoundary: true,
    opener: ["decisione del team", "decisione di squadra", "decisione della squadra", "cambio di decisione", "abbiamo deciso", "decisione:", "il team ha deciso", "è deciso", "è stato deciso", "esito della review", "esito della revisione", "deciso:"],
    changed: ["cambio di decisione", "nuova decisione", "cambio di rotta", "cambio di piano", "è passato da", "è passata da", "ora è * e non più"],
    lasting: ["d'ora in poi", "da ora in poi", "da adesso", "d'ora in avanti", "come regola", "nuova regola", "di regola", "da qui in avanti", "tienilo a mente", "ricordalo", "per tutte le sessioni", "da considerare legacy", "sono deprecate", "è congelato"],
    strong: ["sempre", "mai", "non deve", "non devono", "non deve mai", "deve sempre", "devono sempre", "ogni nuovo", "ogni nuova", "ogni volta", "ogni * nuovo deve", "ogni * nuova deve", "nessun * senza", "nessuna * senza"],
    leadIn: ["a proposito", "anche", "e", "un'altra cosa", "ancora una cosa", "inoltre", "tra l'altro"],
    everyday: ["come sempre","come al solito","come d'abitudine", "come regola generale", "mai riusciti", "mai capito"],
    titles: { decision: "Decisione", changed: "Decisione cambiata" },
    normative: ["mai", "sempre", "deve", "devono", "dovrebbe", "non", "solo", "soltanto", "ogni", "d'ora in poi", "deciso", "decisione", "invece di", "al posto di", "preferito", "obbligatorio", "vietato", "nessun", "nessuna"],
    layout: ["si trova in", "si trovano in", "sta in", "stanno in", "è in", "sono in", "è sotto", "risiede in", "contiene", "contengono", "definito in", "definita in", "salvato in", "memorizzato in", "scrive", "legge", "generato da", "genera", "punta a", "gira da", "viene eseguito da"],
  },
  {
    code: "tr",
    script: "spaced",
    rightBoundary: true,
    opener: ["ekip kararı", "takım kararı", "karar değişikliği", "karar değişti", "kararımız", "karar verdik", "karar aldık", "karar:", "kararı aldık", "karar netleşti", "karar verildi", "kararlaştırdık", "karar aldı"],
    changed: ["karar değişikliği", "karar değişti", "yeni karar", "kararı değiştirdik", "'den * 'ye geçti", "'dan * 'ya geçti", "'ten * 'ye geçti", "'tan * 'ya geçti", "yerine * geçti", "geçiş yaptık"],
    // "artık" alone means "now" or "already" as often as "from now on"; it counts only with a negation or a
    // prohibition ("artık yok", "artık kullanmıyoruz"), the way the person states a change.
    lasting: ["bundan sonra", "bundan böyle", "şu andan itibaren", "bundan sonrası için", "kural olarak", "yeni kural", "artık * yok", "artık * değil", "artık * kullanmıyoruz", "artık * yapmıyoruz", "artık * kullanılmıyor", "artık * kullanılmayacak", "artık * olmayacak", "artık * kullanma", "artık * yapma", "kullanmıyoruz artık", "yapmıyoruz artık", "kullanmayacağız", "yapmayacağız", "aklında tut", "aklında olsun", "tüm oturumlarda", "bütün oturumlarda", "artık * olacak", "legacy sayılıyor", "kaldırılıyor"],
    strong: ["her zaman", "asla", "hiçbir zaman", "kesinlikle", "daima", "yapma", "yapmayın", "yapılmaz", "kullanma", "kullanmayın", "her yeni", "her seferinde", "her yeni * zorunlu", "hiçbir * olmadan", "olmadan * çıkmaz"],
    leadIn: ["bu arada", "ayrıca", "ve", "bir de", "bir şey daha", "not", "hatırlatma"],
    everyday: ["her zamanki gibi","her zaman olduğu gibi","asla olmaz","alışıldığı gibi", "genel kural olarak", "hiç fırsat bulamadık", "hiçbir zaman anlamadım"],
    titles: { decision: "Karar", changed: "Değişen karar" },
    normative: ["asla", "hiçbir zaman", "her zaman", "daima", "kesinlikle", "zorunlu", "gerekir", "gerekli", "malı", "meli", "yapma", "yapmayın", "olmaz", "yalnızca", "sadece", "her", "bundan sonra", "bundan böyle", "artık", "karar", "yerine", "tercih", "yasak", "hiçbir"],
    layout: ["bulunur", "bulunuyor", "yer alır", "yer alıyor", "duruyor", "durur", "içinde", "altında", "içerir", "tanımlı", "tanımlanır", "saklanır", "tutulur", "yazar", "okur", "üretilir", "üretir", "işaret eder", "çalışır"],
  },
  {
    code: "nl",
    script: "spaced",
    rightBoundary: true,
    opener: ["teambesluit", "teambeslissing", "besluit gewijzigd", "gewijzigd besluit", "we hebben besloten", "besluit:", "hebben we besloten", "is het besloten", "is besloten", "uitkomst van de", "besloten:"],
    changed: ["besluit gewijzigd", "gewijzigd besluit", "nieuw besluit", "koerswijziging", "is veranderd van", "verandert van", "is nu * en niet meer"],
    lasting: ["vanaf nu", "voortaan", "in het vervolg", "als regel", "nieuwe regel", "vanaf hier", "onthoud dit", "onthoud dat", "voor al onze sessies", "zijn deprecated", "is bevroren"],
    strong: ["altijd", "nooit", "mag niet", "mogen niet", "moet altijd", "moeten altijd", "elke nieuwe", "iedere nieuwe", "elke keer", "elk nieuw * moet", "elke nieuwe * moet", "geen * zonder"],
    leadIn: ["trouwens", "ook", "en", "nog iets", "nog één ding", "overigens"],
    everyday: ["zoals altijd","zoals gewoonlijk","als altijd", "nooit aan toegekomen", "nooit begrepen"],
    titles: { decision: "Besluit", changed: "Gewijzigd besluit" },
    normative: ["nooit", "altijd", "moet", "moeten", "zou", "niet", "alleen", "elke", "iedere", "vanaf nu", "voortaan", "besloten", "besluit", "in plaats van", "voorkeur", "verplicht", "verboden", "geen"],
    layout: ["staat in", "staan in", "zit in", "zitten in", "ligt in", "bevindt zich", "bevinden zich", "staat onder", "bevat", "bevatten", "gedefinieerd in", "opgeslagen in", "schrijft", "leest", "gegenereerd uit", "genereert", "wijst naar", "draait vanuit"],
  },
  {
    code: "pl",
    script: "spaced",
    rightBoundary: true,
    opener: ["decyzja zespołu", "zmiana decyzji", "zdecydowaliśmy", "postanowiliśmy", "decyzja:", "jest decyzja", "zapadła decyzja", "ustaliliśmy", "wynik przeglądu"],
    changed: ["zmiana decyzji", "nowa decyzja", "zmiana planów", "zmienił się z", "zmieniła się z", "zmieniło się z", "przeszliśmy z * na"],
    lasting: ["od teraz", "od tej pory", "odtąd", "na przyszłość", "jako zasada", "nowa zasada", "z zasady", "od dziś", "od dzisiaj", "zapamiętaj na", "pamiętaj na", "na wszystkie nasze sesje", "jest zamrożone", "uznajemy za"],
    strong: ["zawsze", "nigdy", "nie wolno", "nie może", "nie mogą", "musi zawsze", "muszą zawsze", "każdy nowy", "każda nowa", "każde nowe", "za każdym razem", "każdy nowy * musi", "każda nowa * musi", "żaden * bez", "nic * bez"],
    leadIn: ["przy okazji", "też", "także", "i", "jeszcze jedno", "poza tym"],
    everyday: ["jak zawsze","jak zwykle", "nigdy nie udało", "nigdy nie zrozumiałem"],
    titles: { decision: "Decyzja", changed: "Zmieniona decyzja" },
    normative: ["nigdy", "zawsze", "musi", "muszą", "powinien", "powinna", "nie", "tylko", "każdy", "każda", "każde", "od teraz", "odtąd", "zdecydowaliśmy", "decyzja", "zamiast", "preferowany", "wymagany", "zabroniony", "żaden", "żadna"],
    layout: ["znajduje się w", "znajdują się w", "leży w", "jest w", "są w", "mieszka w", "jest pod", "zawiera", "zawierają", "zdefiniowany w", "zdefiniowana w", "zapisany w", "przechowywany w", "zapisuje", "czyta", "generowany z", "generuje", "wskazuje na", "uruchamia się z"],
  },
  {
    code: "ru",
    script: "spaced",
    rightBoundary: true,
    opener: ["решение команды", "командное решение", "изменение решения", "мы решили", "решение:", "команда решила", "решено:", "решено,", "итог ревью", "итог архитектурного", "по итогам ревью"],
    changed: ["изменение решения", "новое решение", "решение изменилось", "смена курса", "поменялся с", "поменялась с", "переименовала", "теперь * а не", "теперь * не"],
    lasting: ["с этого момента", "отныне", "впредь", "с сегодняшнего дня", "новое правило", "по правилу", "и дальше", "дальше * называется", "держи это в голове", "запомни на", "на все наши сессии", "считаются легаси", "считаются устаревшими", "заморожен"],
    strong: ["всегда", "никогда", "нельзя", "не должен", "не должна", "не должны", "должен всегда", "должны всегда", "каждый новый", "каждая новая", "каждое новое", "каждый раз", "у каждой новой", "у каждого нового", "без * ничего", "ничего * без"],
    leadIn: ["кстати", "также", "и", "ещё одно", "еще одно", "кроме того"],
    everyday: ["как всегда","как обычно", "как правило", "так и не", "никогда не понимал"],
    titles: { decision: "Решение", changed: "Изменённое решение" },
    normative: ["никогда", "всегда", "должен", "должна", "должны", "следует", "нельзя", "не", "только", "каждый", "каждая", "каждое", "отныне", "впредь", "решили", "решение", "вместо", "предпочтительно", "обязательно", "запрещено", "никакой"],
    layout: ["находится в", "находятся в", "лежит в", "лежат в", "живёт в", "живет в", "расположен в", "расположена в", "под", "содержит", "содержат", "определён в", "определен в", "хранится в", "пишет", "читает", "генерируется из", "генерирует", "указывает на", "запускается из"],
  },
  {
    code: "ja",
    script: "cjk",
    rightBoundary: false,
    opener: ["チームの決定", "チーム決定", "決定の変更", "方針変更", "方針を変更", "決めました", "決定しました", "決定:", "決定：", "チームで * 決め", "決めたんです", "決まりました", "ことになりました", "ことにしました", "結論:", "結論：", "の結論"],
    changed: ["決定の変更", "方針変更", "方針を変更", "新しい決定", "に変わりました", "変更になりました", "から * に変わ", "から * に移行"],
    lasting: ["今後は", "これからは", "以後", "以降は", "原則として", "新しいルール", "ルールとして", "今後作成", "今後追加", "今後新しく", "今後すべて", "今後一切", "今後 * ことにします", "今後 * ことにする", "これから", "それと今後", "今後、", "レガシー扱い", "は廃止", "は凍結", "一本化"],
    strong: ["必ず", "常に", "決して", "絶対に", "してはいけない", "してはならない", "禁止", "毎回", "務必", "も例外ではありません", "なしでは * ません", "必ず * てください"],
    leadIn: ["ちなみに", "また", "あと", "それと", "もう一つ", "もうひとつ", "なお"],
    everyday: ["いつも通り","いつものように","いつもどおり"],
    titles: { decision: "決定", changed: "決定の変更" },
    normative: ["決して", "絶対に", "必ず", "常に", "してはいけない", "してはならない", "禁止", "のみ", "だけ", "すべての", "毎", "今後は", "これからは", "決定", "決めました", "代わりに", "ではなく", "優先", "必須", "ない"],
    layout: ["にある", "にあります", "に置かれ", "に置いて", "に入って", "の下にある", "に含まれ", "を含む", "で定義", "に定義", "に保存", "に格納", "に書き", "を読み", "から生成", "を生成", "を指し", "から実行"],
  },
  {
    code: "zh",
    script: "cjk",
    rightBoundary: false,
    opener: ["团队决定", "團隊決定", "决定变更", "決定變更", "改变决定", "改變決定", "我们决定", "我們決定", "决定:", "决定：", "決定:", "決定：", "团队 * 定了", "定了,", "定了，", "决定了", "结论:", "结论：", "的结论"],
    changed: ["决定变更", "決定變更", "改变决定", "改變決定", "新决定", "新決定", "换成了", "改成了", "从 * 换成", "从 * 改成", "改为", "改用"],
    lasting: ["从现在开始", "從現在開始", "今后", "今後", "以后", "以後", "一律", "作为规则", "作為規則", "新规则", "新規則", "从现在起", "从今以后", "统一走", "统一放在", "统一使用", "视为废弃", "算遗留", "冻结", "都要有", "都记住"],
    strong: ["必须", "必須", "一定要", "永远", "永遠", "绝不", "絕不", "从不", "從不", "不得", "不能", "禁止", "每次", "每个新", "每個新", "务必", "都要", "不例外", "也不例外", "没有 * 不"],
    leadIn: ["顺便", "順便", "另外", "还有", "還有", "再说一点", "再說一點", "对了", "對了"],
    everyday: ["像往常一样","像平常一样","一如既往", "从来没", "一直没"],
    titles: { decision: "决定", changed: "决定变更" },
    normative: ["绝不", "絕不", "从不", "永远", "必须", "必須", "一定", "不得", "不能", "禁止", "只", "仅", "每", "所有", "从现在开始", "今后", "一律", "决定", "決定", "而不是", "代替", "优先", "必要", "不"],
    layout: ["位于", "位於", "放在", "在", "存放在", "保存在", "包含", "定义在", "定義在", "写入", "寫入", "读取", "讀取", "生成自", "生成", "指向", "从", "從", "运行"],
  },
  {
    code: "ko",
    script: "spaced",
    rightBoundary: false,
    opener: ["팀 결정", "팀의 결정", "결정 변경", "결정했습니다", "결정했어요", "결정:", "결정했", "결정됐", "결정되었", "하기로 했", "하기로 결정", "결론:", "결론 :", "리뷰 결론"],
    changed: ["결정 변경", "새 결정", "결정이 바뀌", "결정을 바꾸", "로 바뀌었", "로 변경됐", "로 변경되었", "에서 * 로 바", "에서 * 로 옮"],
    lasting: ["이제부터", "앞으로는", "앞으로", "지금부터", "원칙적으로", "새 규칙", "규칙으로", "기억해 주세요", "기억해주세요", "기록하기로", "모든 세션에서", "폐기합니다", "동결", "레거시"],
    strong: ["항상", "절대", "결코", "반드시", "하지 마", "하면 안", "금지", "매번", "모든 새", "없이는 * 안"],
    leadIn: ["참고로", "그리고", "또", "하나 더", "그런데", "덧붙여"],
    everyday: ["늘 그렇듯","평소처럼","언제나처럼", "한 번도"],
    titles: { decision: "결정", changed: "변경된 결정" },
    normative: ["절대", "결코", "항상", "반드시", "하지 마", "하면 안", "금지", "만", "모든", "매", "이제부터", "앞으로", "결정", "대신", "우선", "필수", "않"],
    layout: ["에 있", "에 위치", "에 놓", "에 들어", "아래에 있", "포함", "에 정의", "에 저장", "에 쓰", "를 읽", "을 읽", "에서 생성", "생성", "를 가리", "을 가리", "에서 실행"],
  },
];

/** A sentence this long is a rule, not a passing word, when its only marker is a strong word. */
export function strongMinimum(lang: LanguageMarkers, sentence: string): boolean {
  if (lang.script === "cjk") return sentence.replace(/\s+/g, "").length >= 20;
  return sentence.trim().split(/\s+/).length >= (lang.code === "ko" ? 6 : 8);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** " * " inside a phrase: up to 40 characters of the same sentence between the two parts ("artık * yok"). */
const GAP = "(?:\\s[^.!?。！？]{0,40}?)?\\s";
const phrasePattern = (p: string): string => p.split(" * ").map(escape).join(GAP);

/** One regex for a phrase list, with the language's boundary rule. Lower case in, lower case matched. */
export function phraseRegex(lang: Pick<LanguageMarkers, "script" | "rightBoundary">, phrases: readonly string[]): RegExp | null {
  if (phrases.length === 0) return null;
  const body = phrases.map(phrasePattern).sort((a, z) => z.length - a.length).join("|");
  if (lang.script === "cjk") return new RegExp(`(?:${body})`, "u");
  const left = "(?<![\\p{L}\\p{N}])";
  const right = lang.rightBoundary ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}(?:${body})${right}`, "u");
}

export interface CompiledMarkers {
  lang: LanguageMarkers;
  opener: RegExp | null;
  changed: RegExp | null;
  lasting: RegExp | null;
  strong: RegExp | null;
  leadIn: RegExp | null;
  everyday: RegExp | null;
}

let compiled: CompiledMarkers[] | null = null;

/** The table compiled once. */
export function compiledMarkers(): readonly CompiledMarkers[] {
  if (!compiled) {
    compiled = LASTING_MARKERS.map((lang) => ({
      lang,
      opener: phraseRegex(lang, lang.opener),
      changed: phraseRegex(lang, lang.changed),
      lasting: phraseRegex(lang, [...lang.opener, ...lang.lasting]),
      strong: phraseRegex(lang, lang.strong),
      leadIn: phraseRegex(lang, lang.leadIn),
      everyday: phraseRegex(lang, lang.everyday),
    }));
  }
  return compiled;
}

/** Every language's everyday idioms, one regex: "como sempre" is no rule whichever language's "sempre" it meets. */
export function everydayRegex(): RegExp {
  return unionRegex((l) => l.everyday);
}

/** Every language's normative words, one regex over a lower-cased sentence. */
export function normativeRegex(): RegExp {
  return unionRegex((l) => l.normative);
}

/** Every language's layout verbs, one regex over a lower-cased sentence. */
export function layoutRegex(): RegExp {
  return unionRegex((l) => l.layout);
}

const unions = new Map<string, RegExp>();
function unionRegex(pick: (l: LanguageMarkers) => string[]): RegExp {
  const key = pick(LASTING_MARKERS[0]!).join("|");
  const hit = unions.get(key);
  if (hit) return hit;
  const parts: string[] = [];
  for (const lang of LASTING_MARKERS) {
    const re = phraseRegex(lang, pick(lang));
    if (re) parts.push(re.source);
  }
  const re = new RegExp(parts.map((p) => `(?:${p})`).join("|"), "u");
  unions.set(key, re);
  return re;
}

/**
 * Sentences of a text. Spaced scripts break after . ! ? before a capital, a quote or an opening mark;
 * Japanese and Chinese break after 。！？ with nothing required after; a line break always breaks.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？])|(?<=[.!?])\s+(?=[\p{Lu}`"'(«„¿¡])/u))
    .map((s) => s.trim())
    .filter(Boolean);
}
