/*! NutriAI v1.0 — IA leve para sites de alimentação saudável. Zero dependências, roda 100% no navegador.
 *
 *  Módulos:
 *   1. Busca semântica  — TF-IDF + bigramas + sinônimos + correção ortográfica (Levenshtein)
 *   2. Recomendação     — perfil de gosto que aprende com curtidas (vetor de preferências) + ajuste de macros + diversidade (MMR)
 *   3. Cardápio         — otimizador por busca local: bate a meta de kcal/macros do dia, ajusta porções e evita repetição
 *   4. Metas            — Mifflin-St Jeor + fator de atividade + objetivo → kcal, proteína, carbo, gordura, água, IMC
 *   5. Assistente (chat)— NLU com regras + Naive Bayes, extração de entidades (peso, altura, restrições...) e memória de contexto
 *   6. Lista de compras — soma ingredientes do cardápio por unidade
 *
 *  Uso:
 *    const ia = new NutriAI(receitas);              // receitas: [{id, nome, ingredientes[], kcal, proteina, carbo, gordura, ...}]
 *    ia.responder('quero um jantar vegano rápido');  // → { texto, receitas, cardapio, metas, sugestoes, intent }
 *    ia.buscar('frnago com batata doce');           // busca tolerante a erros
 *    ia.calcularMetas({ peso: 70, altura: 175, idade: 30, sexo: 'm', atividade: 'moderado', objetivo: 'perder' });
 *    ia.gerarCardapio({ metas, dias: 7, filtros: { restricoes: ['sem_lactose'] } });
 *    ia.feedback(idReceita, 'curtir' | 'descurtir' | 'ver' | 'cozinhar');
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NutriAI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================
   * 1. TEXTO (PT-BR)
   * ===================================================================== */
  const fold = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const STOP = new Set((
    'a o as os um uma uns umas de da do das dos e ou em no na nos nas num numa para pra pro por pelo pela com sem que se ' +
    'ao aos eu me mim meu minha voce tem ter ver mais menos muito muita pouco pouca bem fazer faz como qual quais quanto ' +
    'quantos quantas quero queria gostaria preciso algo alguma algum isso esse essa este esta ai la tipo receita receitas ' +
    'prato pratos comida opcao opcoes favor sugere sugira sugestao sugestoes indica indique mostra mostre manda ideia ideias ' +
    'hoje amanha comer cozinhar preparar dia tenho gostoso gostosa delicioso deliciosa bom boa ' +
    'g kg ml xicara xicaras colher colheres unidade unidades pitada gosto fatia fatias dente dentes lata latas'
  ).split(' '));

  // plural → singular (stemmer leve; aplicado igualmente em receitas e perguntas)
  const PLURAL = [['oes', 'ao'], ['aes', 'ao'], ['ais', 'al'], ['eis', 'el'], ['ois', 'ol'], ['uis', 'ul'],
                  ['ns', 'm'], ['res', 'r'], ['zes', 'z'], ['ses', 's'], ['s', '']];
  function stem(w) {
    if (w.length < 4 || /[^a-z]/.test(w)) return w;
    for (const [suf, rep] of PLURAL) if (w.endsWith(suf)) return w.slice(0, -suf.length) + rep;
    return w;
  }

  // sinônimos regionais → termo canônico
  const SIN = { galinha: 'frango', aipim: 'mandioca', macaxeira: 'mandioca', jerimum: 'abobora', janta: 'jantar',
                bife: 'carne', boi: 'carne', bovina: 'carne', mussarela: 'mucarela', muzzarela: 'mucarela',
                proteica: 'proteico', integrai: 'integral' };

  // termos implícitos (salmão também é peixe; patinho também é carne...)
  const EXPANDE = {};
  ['salmao', 'tilapia', 'atum', 'sardinha', 'merluza', 'bacalhau', 'pescada', 'robalo', 'truta', 'linguado'].forEach(t => EXPANDE[t] = ['peixe']);
  ['patinho', 'musculo', 'alcatra', 'acem', 'maminha', 'fraldinha', 'contrafile', 'picanha', 'cupim', 'lagarto'].forEach(t => EXPANDE[t] = ['carne']);
  ['mucarela', 'cottage', 'ricota', 'parmesao', 'minas', 'provolone', 'cheddar'].forEach(t => EXPANDE[t] = ['queijo']);
  ['camarao', 'lula', 'polvo', 'mexilhao'].forEach(t => EXPANDE[t] = ['frutos_mar']);
  EXPANDE.tofu = ['soja']; EXPANDE.whey = ['proteina'];

  function tokens(text) {
    const out = [];
    const limpo = fold(text).replace(/\b(colher(es)?|xicaras?)( de (sopa|cha|sobremesa))?\b/g, ' ');
    for (const raw of limpo.split(/[^a-z0-9]+/)) {
      if (raw.length < 2 || STOP.has(raw) || /^\d/.test(raw)) continue;
      const t = stem(raw);
      out.push(SIN[t] || t);
    }
    return out;
  }
  function terms(text) { // unigramas + bigramas ("batata_doce", "peito_frango")
    const tk = tokens(text), out = tk.slice();
    for (let i = 1; i < tk.length; i++) out.push(tk[i - 1] + '_' + tk[i]);
    return out;
  }

  // Distância de edição (Damerau/OSA: letras trocadas contam 1) com corte antecipado
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let pp = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
        cur.push(v); if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      pp = prev; prev = cur;
    }
    return prev[b.length];
  }

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r1 = x => Math.round(x * 10) / 10;
  const num = s => parseFloat(String(s).replace(',', '.'));
  function rng(seed) { // mulberry32 — aleatório reprodutível
    let a = (typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* =====================================================================
   * 2. RESTRIÇÕES ALIMENTARES (inferidas dos ingredientes)
   * ===================================================================== */
  const CARNES = ['frango', 'carne', 'peixe', 'porco', 'suino', 'bacon', 'presunto', 'peru', 'linguica', 'salsicha', 'frutos_mar',
                  'mortadela', 'salame', 'costela', 'figado', 'pernil', 'lombo', 'calabresa', 'charque', 'banha', 'gelatina'];
  const LACTEOS = ['leite', 'queijo', 'iogurte', 'manteiga', 'requeijao', 'creme', 'whey', 'nata', 'chantilly', 'coalhada', 'kefir'];
  const ANIMAIS = CARNES.concat(LACTEOS, ['ovo', 'mel', 'gema', 'clara']);
  const GLUTEN = ['trigo', 'pao', 'macarrao', 'massa', 'aveia', 'cevada', 'centeio', 'biscoito', 'bolacha', 'torrada', 'tortilha',
                  'wrap', 'rosca', 'shoyu', 'cerveja', 'malte', 'seitan', 'granola', 'lasanha', 'empanado'];
  const VEGETAL_RE = /(coco|amendoa|aveia|soja|castanha|arroz|vegetal|sem lactose|zero lactose|vegan)/;
  const SEM_GLUTEN_RE = /(sem gluten|de arroz|de milho|de mandioca|tapioca|de queijo|grao de bico|de amendoa|de coco|de abobrinha)/;

  function calcularFlags(r) {
    const linhas = r._ing.map(l => ({ f: fold(l), t: new Set(terms(l).flatMap(t => [t].concat(EXPANDE[t] || []))) }));
    const tem = (lista, excecao) => linhas.some(l => lista.some(x => l.t.has(x)) && !(excecao && excecao.test(l.f)));
    const tags = r.tags.join(' ');
    const vegano = /vegan/.test(tags) || !tem(ANIMAIS, VEGETAL_RE);
    const kc = r.kcal || 1;
    return {
      vegano,
      vegetariano: vegano || /vegetarian/.test(tags) || !tem(CARNES),
      sem_lactose: /sem lactose/.test(tags) || !tem(LACTEOS, VEGETAL_RE),
      sem_gluten: /sem gluten/.test(tags) || !tem(GLUTEN, SEM_GLUTEN_RE),
      low_carb: /low carb/.test(tags) || (r.carbo * 4) / kc <= 0.26,
      proteico: r.proteina >= 25 || (r.proteina * 4) / kc >= 0.3,
    };
  }
  const ROTULO_RESTR = { vegano: 'vegana', vegetariano: 'vegetariana', sem_lactose: 'sem lactose', sem_gluten: 'sem glúten',
                         low_carb: 'low carb', proteico: 'rica em proteína' };

  /* =====================================================================
   * 3. NUTRIÇÃO
   * ===================================================================== */
  const MACROS = ['kcal', 'proteina', 'carbo', 'gordura'];
  const PESO_MACRO = { kcal: 1, proteina: 1, carbo: 0.5, gordura: 0.5 };
  // erro relativo ponderado; passar da meta de proteína é penalizado bem menos
  function erroMacro(v, alvo) {
    let e = 0, w = 0;
    for (const k of MACROS) if (alvo[k]) {
      let d = (v[k] - alvo[k]) / alvo[k];
      if (k === 'proteina' && d > 0) d *= 0.3;
      e += PESO_MACRO[k] * Math.abs(d); w += PESO_MACRO[k];
    }
    return w ? e / w : 0;
  }
  function ajuste(r, alvo) { // melhor porção (0.5x–2x, passos de 0.25) para a meta
    const m = alvo.kcal && r.kcal ? clamp(Math.round(alvo.kcal / r.kcal * 4) / 4, 0.5, 2) : 1;
    const err = erroMacro({ kcal: r.kcal * m, proteina: r.proteina * m, carbo: r.carbo * m, gordura: r.gordura * m }, alvo);
    return { m, err, fit: 1 / (1 + 4 * err) };
  }
  const escala = (metas, f) => ({ kcal: metas.kcal * f, proteina: metas.proteina * f, carbo: metas.carbo * f, gordura: metas.gordura * f });

  const FATOR_ATIV = { sedentario: 1.2, leve: 1.375, moderado: 1.55, intenso: 1.725, atleta: 1.9 };
  const DIVISAO = { cafe: 0.25, almoco: 0.35, lanche: 0.12, jantar: 0.28, ceia: 0.08 };
  const ROTULO_REF = { cafe: 'Café da manhã', almoco: 'Almoço', lanche: 'Lanche', jantar: 'Jantar', ceia: 'Ceia' };
  function normRefeicao(s) {
    const f = fold(s);
    if (/cafe|desjejum|manha/.test(f)) return 'cafe';
    if (/almoc/.test(f)) return 'almoco';
    if (/jant/.test(f)) return 'jantar';
    if (/lanch|merenda|treino/.test(f)) return 'lanche';
    if (/ceia/.test(f)) return 'ceia';
    return f;
  }

  /* =====================================================================
   * 4. SUBSTITUIÇÕES SAUDÁVEIS
   * ===================================================================== */
  const SUBST = [
    [/acucar/, 'açúcar', ['tâmaras ou banana madura amassada', 'eritritol ou xilitol', 'mel (use 30% menos)', 'canela/baunilha para realçar o doce']],
    [/farinha (de )?trigo|farinha branca/, 'farinha de trigo', ['farinha de aveia', 'farinha de amêndoas (low carb)', 'farinha de arroz (sem glúten)', 'farinha de grão-de-bico']],
    [/arroz( branco)?/, 'arroz branco', ['arroz integral', 'quinoa', 'couve-flor ralada (low carb)', 'cevadinha']],
    [/creme de leite/, 'creme de leite', ['iogurte natural', 'ricota batida', 'creme de castanha de caju (vegano)', 'leite de coco light']],
    [/leite condensado/, 'leite condensado', ['leite em pó + tâmaras batidos', 'pasta de tâmara', 'leite de coco reduzido com xilitol']],
    [/\bleite\b/, 'leite', ['bebida de aveia', 'leite de amêndoas', 'leite sem lactose', 'leite de coco']],
    [/manteiga/, 'manteiga', ['azeite de oliva', 'óleo de coco', 'pasta de amendoim (em doces)', 'abacate (em bolos)']],
    [/oleo|fritura|fritar/, 'óleo/fritura', ['air fryer ou forno', 'azeite em spray', 'grelhar ou assar']],
    [/macarrao|massa/, 'macarrão', ['macarrão integral', 'espaguete de abobrinha', 'macarrão de grão-de-bico ou lentilha', 'palmito pupunha em fitas']],
    [/batata( inglesa)?/, 'batata', ['batata-doce', 'mandioquinha', 'abóbora', 'inhame']],
    [/\bsal\b/, 'sal', ['ervas frescas', 'limão', 'alho e cebola', 'páprica e cúrcuma']],
    [/carne( vermelha)?|bife/, 'carne vermelha', ['frango ou peixe', 'lentilha ou grão-de-bico', 'cogumelos', 'tofu']],
    [/\bovos?\b/, 'ovo', ['1 col. linhaça + 3 col. água (por ovo)', 'chia hidratada', '1/2 banana amassada (doces)', 'aquafaba']],
    [/queijo/, 'queijo', ['tofu temperado', 'levedura nutricional', 'ricota ou cottage', 'queijo de castanha']],
    [/maionese/, 'maionese', ['iogurte natural com limão e mostarda', 'abacate amassado', 'homus']],
    [/refrigerante/, 'refrigerante', ['água com gás e limão', 'chá gelado sem açúcar', 'suco natural diluído']],
    [/chocolate/, 'chocolate', ['cacau em pó 100%', 'chocolate 70%+', 'alfarroba']],
    [/\bpao\b/, 'pão branco', ['pão integral', 'tapioca', 'crepioca', 'wrap de folhas']],
    [/requeijao/, 'requeijão', ['ricota temperada', 'cottage', 'homus']],
  ];

  /* =====================================================================
   * 5. NLU — Naive Bayes + regras + entidades
   * ===================================================================== */
  const TREINO = {
    saudacao: ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'opa tudo bem', 'hey tudo certo'],
    ajuda: ['ajuda', 'o que voce faz', 'como funciona', 'o que posso perguntar', 'me ajuda', 'quais funcoes voce tem', 'nao sei usar', 'o que voce sabe fazer'],
    agradecer: ['obrigado', 'obrigada', 'valeu', 'muito obrigado', 'show de bola', 'perfeito obrigado', 'top valeu'],
    buscar: ['quero uma receita de frango', 'receita com batata doce', 'me mostra algo com aveia', 'o que posso fazer com ovo',
      'tem receita vegana', 'receita rapida para o jantar', 'sugestao de lanche saudavel', 'quero algo doce e fit', 'opcoes de cafe da manha',
      'prato com muita proteina', 'receita low carb', 'algo sem gluten para o almoco', 'o que eu como hoje', 'ideia de janta leve',
      'quero comer algo gostoso', 'sugere um almoco', 'tem alguma coisa com peixe', 'me indica um lanche'],
    cardapio: ['monta um cardapio', 'gera um cardapio semanal', 'plano alimentar para a semana', 'cardapio de 3 dias', 'quero uma dieta',
      'faz minha dieta', 'organiza minhas refeicoes', 'planejamento de refeicoes', 'menu da semana'],
    metas: ['quantas calorias eu preciso', 'calcular minhas calorias', 'quanto de proteina devo comer', 'minha meta diaria',
      'calcula meus macros', 'qual meu gasto calorico', 'qual minha taxa metabolica', 'peso 80 kg altura 1,80', 'meu imc',
      'quanto devo comer para emagrecer'],
    substituir: ['como substituir acucar', 'troca saudavel para farinha', 'o que usar no lugar do leite', 'substituto para ovo',
      'posso trocar arroz por que', 'alternativa ao creme de leite', 'nao tenho manteiga o que uso'],
    nutricao: ['quantas calorias tem a panqueca', 'qual a proteina dessa receita', 'informacao nutricional do bolo',
      'quantos carboidratos tem o omelete', 'valor calorico da salada', 'macros do frango grelhado'],
    parecida: ['receita parecida com essa', 'algo similar a primeira', 'outra parecida', 'semelhante ao bolo de banana'],
    mais: ['mais', 'mostra mais', 'outras opcoes', 'tem outras', 'proxima', 'mais sugestoes', 'manda outras'],
    gostei: ['gostei', 'adorei essa', 'amei', 'curti a primeira', 'gostei da segunda', 'essa e boa'],
    nao_gostei: ['nao gostei', 'nao curti', 'odeio isso', 'nao gosto dessa', 'essa nao', 'eca'],
  };
  function nbTokens(txt) {
    const w = fold(txt).replace(/\d+([.,]\d+)?/g, ' 0 ').split(/[^a-z0-9]+/).filter(Boolean).map(stem);
    const out = w.slice();
    for (let i = 1; i < w.length; i++) out.push(w[i - 1] + '_' + w[i]);
    return out;
  }
  function treinarNB(dados) {
    const m = { classes: {}, vocab: new Set(), total: 0 };
    for (const [c, frases] of Object.entries(dados)) {
      const cnt = new Map(); let n = 0;
      for (const f of frases) for (const t of nbTokens(f)) { cnt.set(t, (cnt.get(t) || 0) + 1); n++; m.vocab.add(t); }
      m.classes[c] = { cnt, n, prior: frases.length };
      m.total += frases.length;
    }
    return m;
  }
  function classificarNB(m, txt) {
    const todos = nbTokens(txt), tk = todos.filter(t => m.vocab.has(t)), V = m.vocab.size;
    if (!tk.length) return { intent: null, conf: 0 };
    const logs = [];
    for (const [c, d] of Object.entries(m.classes)) {
      let s = Math.log(d.prior / m.total);
      for (const t of tk) s += Math.log(((d.cnt.get(t) || 0) + 1) / (d.n + V));
      logs.push([c, s]);
    }
    const mx = Math.max(...logs.map(x => x[1]));
    const soma = logs.reduce((s, x) => s + Math.exp(x[1] - mx), 0);
    logs.sort((a, b) => b[1] - a[1]);
    const cobertura = tk.length / todos.length;
    return { intent: logs[0][0], conf: (1 / soma) * Math.sqrt(cobertura) };
  }

  const ORDINAIS = ['primeir', 'segund', 'terceir', 'quart', 'quint', 'sext'];
  function extrair(t) {
    const e = { restricoes: [], excluir: [] };
    let m;
    // --- dados corporais
    if ((m = t.match(/(\d{2,3}(?:[.,]\d+)?)\s*(?:kg|quilos?|kilos?)\b/)) || (m = t.match(/\bpes[oa]\s*(?:de\s*)?(\d{2,3}(?:[.,]\d+)?)/))) e.peso = num(m[1]);
    if ((m = t.match(/\b([12][.,]\d{1,2})\s*(?:m|metros?)\b/)) || (m = t.match(/altura\s*(?:de\s*)?([12][.,]\d{1,2})/)) ||
        (m = t.match(/\b(1[.,][4-9]\d|2[.,][0-2]\d)\b(?!\s*(?:kg|quilo|kilo))/))) e.altura = Math.round(num(m[1]) * 100);
    else if ((m = t.match(/\b(\d{3})\s*cm\b/)) || (m = t.match(/altura\s*(?:de\s*)?(\d{3})\b/))) e.altura = +m[1];
    else if ((m = t.match(/\b1\s*(?:m|metro)\s*e\s*(\d{2})\b/))) e.altura = 100 + +m[1];
    if ((m = t.match(/(\d{1,3})\s*anos\b/)) || (m = t.match(/\bidade\s*(?:de\s*)?(\d{1,3})/))) e.idade = +m[1];
    if (/\b(homem|masculino|rapaz|sou um cara)\b/.test(t)) e.sexo = 'm';
    else if (/\b(mulher|feminino|moca|garota)\b/.test(t)) e.sexo = 'f';
    if (/emagrec|perder (peso|gordura|barriga)|\bsecar\b|definir|deficit/.test(t)) e.objetivo = 'perder';
    else if (/ganhar (massa|peso|musculo)|hipertrofia|engordar|bulking|superavit/.test(t)) e.objetivo = 'ganhar';
    else if (/manter (o )?peso|manutencao/.test(t)) e.objetivo = 'manter';
    if (/sedentari|nao (treino|faco exercicio|pratico)/.test(t)) e.atividade = 'sedentario';
    else if (/\batleta\b|treino (pesado )?todo dia|2 vezes (por|ao) dia/.test(t)) e.atividade = 'atleta';
    else if ((m = t.match(/(\d)\s*(?:x|vezes)\s*(?:por|na|a|ao)?\s*semana/))) { const n = +m[1]; e.atividade = n <= 1 ? 'sedentario' : n <= 3 ? 'leve' : n <= 5 ? 'moderado' : 'intenso'; }
    else if (/muito ativ|intensa?mente|treino intenso/.test(t)) e.atividade = 'intenso';
    else if (/moderad/.test(t)) e.atividade = 'moderado';
    else if (/pouco ativ|levemente ativ|atividade leve|caminhad/.test(t)) e.atividade = 'leve';
    // --- refeição e restrições
    if (/cafe da manha|desjejum|\bcafe\b/.test(t)) e.refeicao = 'cafe';
    else if (/almoc/.test(t)) e.refeicao = 'almoco';
    else if (/\bjant(a|ar|inha)\b/.test(t)) e.refeicao = 'jantar';
    else if (/lanch|merenda|pre[- ]?treino|pos[- ]?treino/.test(t)) e.refeicao = 'lanche';
    else if (/\bceia\b/.test(t)) e.refeicao = 'ceia';
    if (/vegan/.test(t)) e.restricoes.push('vegano');
    else if (/vegetarian/.test(t)) e.restricoes.push('vegetariano');
    if (/(sem|zero|intoleran\w*( a)?) lactose/.test(t)) e.restricoes.push('sem_lactose');
    if (/(sem|zero) gluten|celiac/.test(t)) e.restricoes.push('sem_gluten');
    if (/low ?carb|(pouco|baixo|sem|menos) carbo/.test(t)) e.restricoes.push('low_carb');
    if (/(ric[oa]|muita|alt[oa]|bastante|mais) (em |de )?proteina|proteic/.test(t)) e.restricoes.push('proteico');
    e.permanente = /\bsou (vegan|vegetarian|celiac|intolerante)|tenho (intolerancia|alergia)|\bnao (como|posso comer|consumo|gosto de)\b|alergic/.test(t);
    const IGN = /^(lactose|gluten|carbo\w*|graca|duvida|problema|pressa|tempo)$/;
    for (const mm of t.matchAll(/\bsem ([a-z]+(?: de [a-z]+)?)/g)) if (!IGN.test(mm[1].split(' ')[0])) e.excluir.push(mm[1]);
    for (const mm of t.matchAll(/\b(?:nao (?:gosto|como|posso comer|consumo)|alergi\w* (?:a|ao|de)|alergic[oa] (?:a|ao)|odeio)\s+(?:de\s+)?([a-z]+)/g))
      if (!/^(nada|isso|dessa|desse|essa|esse)$/.test(mm[1])) e.excluir.push(mm[1]);
    // --- limites
    if ((m = t.match(/(\d{1,3})\s*min/))) e.maxTempo = +m[1];
    else if (/rapid|pratic|facil|faceis/.test(t)) e.maxTempo = 20;
    if ((m = t.match(/(?:ate|menos de|abaixo de|no maximo|max)\s*(\d{2,4})\s*(?:kcal|calorias|cal)\b/))) e.maxKcal = +m[1];
    else if (/\bleve\b/.test(t)) e.maxKcal = 420;
    if ((m = t.match(/(\d{1,2})\s*dias/))) e.dias = clamp(+m[1], 1, 14);
    else if (/semana/.test(t)) e.dias = 7;
    else if (/\b(hoje|amanha|um dia|1 dia)\b/.test(t)) e.dias = 1;
    // --- referência a resultado anterior ("a segunda", "opção 3")
    if ((m = t.match(new RegExp('\\b(' + ORDINAIS.join('|') + ')[ao]\\b')))) e.ordem = ORDINAIS.indexOf(m[1]);
    else if ((m = t.match(/(?:numero|n[o°º]|#|opcao|receita)\s*(\d)\b/))) e.ordem = +m[1] - 1;
    return e;
  }
  function limparConsulta(t) {
    return t
      .replace(/\bsem\s+[a-z]+(\s+de\s+[a-z]+)?/g, ' ')
      .replace(/\b(nao (gosto|como|posso comer|consumo)|alergi\w* (a|ao|de)|odeio)\s+(de\s+)?[a-z]+/g, ' ')
      .replace(/\d+([.,]\d+)?\s*(kg|quilos?|kcal|calorias|cal|min(utos)?|g|gramas|anos|cm|m|dias|x|vezes)?\b/g, ' ')
      .replace(/\b(cafe da manha|almoc\w*|jantar|janta|jantinha|lanche\w*|ceia|low ?carb|vegan\w*|vegetarian\w*|rapid\w*|pratic\w*|facil|faceis|saudave(l|is)|fit|leve|proteic\w*|ric[oa] em proteina|muita proteina|ate|menos de|abaixo de|no maximo|hoje|amanha|calorias?|kcal|carboidratos?|proteinas?|gorduras?|informac\w*|nutricion\w*|valor|calorico|macros|tabela|quant[oa]s?|parecid\w*|similar\w*|semelhante\w*|igual|gostei|outr[ao]s?|receitas?)\b/g, ' ');
  }

  /* =====================================================================
   * 6. LISTA DE COMPRAS
   * ===================================================================== */
  const NUMPAL = { meia: 0.5, meio: 0.5, um: 1, uma: 1, dois: 2, duas: 2, tres: 3 };
  const RE_ING = /^(\d+(?:[.,]\d+)?|\d+\/\d+|meia|meio|uma?|dois|duas|tres)\s*(kg|quilos?|g|gramas?|l|litros?|ml|xicaras?(?: de cha)?|colher(?:es)?(?: de (?:sopa|cha|sobremesa))?|latas?|dentes?|fatias?|folhas?|unidades?)?\s+(?:de\s+)?(.+)$/;
  function unidade(u) {
    if (!u) return ['un', 1];
    if (/^(kg|quilos?)$/.test(u)) return ['g', 1000];
    if (/^(g|gramas?)$/.test(u)) return ['g', 1];
    if (/^(l|litros?)$/.test(u)) return ['ml', 1000];
    if (u === 'ml') return ['ml', 1];
    if (/^xicara/.test(u)) return ['xícara', 1];
    if (/cha$/.test(u)) return ['colher de chá', 1];
    if (/^colher/.test(u)) return ['colher de sopa', 1];
    return [u.replace(/s$/, ''), 1];
  }
  function fmtQtd(q, u) {
    if (u === 'g' && q >= 1000) return r1(q / 1000).toString().replace('.', ',') + ' kg';
    if (u === 'ml' && q >= 1000) return r1(q / 1000).toString().replace('.', ',') + ' L';
    const v = u === 'g' || u === 'ml' ? Math.ceil(q / 10) * 10 : Math.ceil(q * 2) / 2;
    return String(v).replace('.', ',') + (u === 'un' ? '' : ' ' + u);
  }

  /* =====================================================================
   * 7. ARMAZENAMENTO (localStorage opcional)
   * ===================================================================== */
  function lsStore() {
    try {
      const ls = globalThis.localStorage; ls.setItem('__nai', '1'); ls.removeItem('__nai');
      return { get: k => { try { return JSON.parse(ls.getItem(k) || 'null'); } catch (_) { return null; } },
               set: (k, v) => { try { ls.setItem(k, JSON.stringify(v)); } catch (_) {} } };
    } catch (_) { return null; }
  }
  const PESO_FEEDBACK = { ver: 0.15, curtir: 1, cozinhar: 1.5, descurtir: -0.8 };

  /* =====================================================================
   * 8. MOTOR
   * ===================================================================== */
  class NutriAI {
    constructor(receitas, opcoes = {}) {
      this.opcoes = opcoes;
      this.llm = opcoes.llm || null;
      this._store = opcoes.armazenamento === undefined ? lsStore() : opcoes.armazenamento;
      this._chave = opcoes.chave || 'nutriai:usuario';
      this.R = receitas.map((r, i) => this._prep(r, i));
      this.N = this.R.length;
      this._byId = new Map(this.R.map(r => [String(r.id), r]));
      this._indexar();
      this._nb = treinarNB(TREINO);
      this._corrCache = new Map();
      this._simCache = new Map();
      this.usuario = this._carregarUsuario();
      this.ctx = { ultimos: [], vistos: new Set(), ultimaBusca: null, foco: null };
    }

    /* ---------- preparação e índice ---------- */
    _prep(r, i) {
      const ing = (r.ingredientes || []).map(x => typeof x === 'string' ? x : (x.quantidade ? x.quantidade + ' ' : '') + (x.nome || ''));
      const p = {
        _o: r, _i: i, id: r.id == null ? i : r.id, nome: r.nome || 'Receita ' + i,
        kcal: +r.kcal || +r.calorias || 0, proteina: +r.proteina || +r.proteinas || 0,
        carbo: +r.carbo || +r.carboidratos || 0, gordura: +r.gordura || +r.gorduras || 0,
        tempo: +r.tempo || 0, porcoes: +r.porcoes || 1, avaliacao: +r.avaliacao || 0,
        refeicao: [].concat(r.refeicao || []).map(normRefeicao),
        tags: (r.tags || []).map(t => fold(t).replace(/[-_]/g, ' ')),
        _ing: ing,
      };
      p._flags = calcularFlags(p);
      return p;
    }
    _indexar() {
      const df = new Map(), brutos = [];
      for (const r of this.R) {
        const tf = new Map();
        const add = (lista, w) => {
          for (const txt of lista) for (const t of terms(txt)) {
            tf.set(t, (tf.get(t) || 0) + w);
            for (const x of EXPANDE[t] || []) tf.set(x, (tf.get(x) || 0) + w * 0.5);
          }
        };
        add([r.nome], 3); add(r.tags, 2); add([r._o.categoria || ''], 2); add(r._ing, 1.5); add([r._o.descricao || ''], 0.7);
        r._ingTerms = new Set();
        for (const l of r._ing.concat(r.nome)) for (const t of terms(l)) { r._ingTerms.add(t); for (const x of EXPANDE[t] || []) r._ingTerms.add(x); }
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
        brutos.push(tf);
      }
      this.idf = new Map();
      for (const [t, d] of df) this.idf.set(t, Math.log(1 + this.N / d));
      this.inv = new Map();
      brutos.forEach((tf, i) => {
        const v = new Map(); let n = 0;
        for (const [t, f] of tf) { const w = Math.log1p(f) * this.idf.get(t); v.set(t, w); n += w * w; }
        n = Math.sqrt(n) || 1;
        for (const [t, w] of v) {
          const u = w / n; v.set(t, u);
          if (!this.inv.has(t)) this.inv.set(t, []);
          this.inv.get(t).push([i, u]);
        }
        this.R[i]._v = v;
      });
      this.vocab = [...this.idf.keys()].filter(t => !t.includes('_'));
    }
    _corrigir(t) {
      if (this.idf.has(t)) return t;
      if (this._corrCache.has(t)) return this._corrCache.get(t);
      let melhor = null;
      if (t.length >= 3) {
        const max = t.length >= 8 ? 2 : 1; let bd = max + 1, bi = Infinity;
        for (const v of this.vocab) {
          const d = t.length >= 4 && v.startsWith(t) ? 0.5 : lev(t, v, max);
          if (d > max) continue;
          const idf = this.idf.get(v);
          if (d < bd || (d === bd && idf < bi)) { bd = d; bi = idf; melhor = v; }
        }
      }
      this._corrCache.set(t, melhor);
      return melhor;
    }
    // pontua todas as receitas para um texto (cosseno TF-IDF)
    _pontuar(texto) {
      const correcoes = [], fixos = [];
      for (const t of tokens(texto)) {
        const c = this._corrigir(t);
        if (!c) continue;
        if (c !== t) correcoes.push([t, c]);
        fixos.push(c);
      }
      const q = new Map();
      const add = t => { const idf = this.idf.get(t); if (idf) q.set(t, (q.get(t) || 0) + idf); };
      fixos.forEach((t, i) => { add(t); if (i) add(fixos[i - 1] + '_' + t); });
      if (!q.size) return null;
      let qn = 0; for (const w of q.values()) qn += w * w; qn = Math.sqrt(qn);
      const s = new Float64Array(this.N);
      for (const [t, w] of q) for (const [i, dw] of this.inv.get(t)) s[i] += (w / qn) * dw;
      return { s, correcoes, termos: fixos };
    }
    _sim(a, b) {
      if (a === b) return 1;
      const k = a._i < b._i ? a._i * this.N + b._i : b._i * this.N + a._i;
      let v = this._simCache.get(k);
      if (v === undefined) {
        const [p, q] = a._v.size < b._v.size ? [a._v, b._v] : [b._v, a._v];
        v = 0; for (const [t, w] of p) { const x = q.get(t); if (x) v += w * x; }
        this._simCache.set(k, v);
      }
      return v;
    }

    /* ---------- filtros ---------- */
    _filtros(f = {}) {
      const u = this.usuario;
      const restricoes = [...new Set([].concat(f.restricoes || [], u.restricoes || []))];
      const excl = [].concat(f.excluirIngredientes || [], u.alergias || []).flatMap(x => tokens(x));
      return { ...f, restricoes, excluirIngredientes: [...new Set(excl)], refeicao: f.refeicao ? normRefeicao(f.refeicao) : null };
    }
    _passa(r, f) {
      for (const x of f.restricoes || []) if (!r._flags[x]) return false;
      for (const t of f.excluirIngredientes || []) if (r._ingTerms.has(t)) return false;
      if (f.refeicao && r.refeicao.length && !r.refeicao.includes(f.refeicao)) return false;
      if (f.maxKcal && r.kcal > f.maxKcal) return false;
      if (f.maxTempo && r.tempo && r.tempo > f.maxTempo) return false;
      if (f.minProteina && r.proteina < f.minProteina) return false;
      if (f.excluirIds && f.excluirIds.has(String(r.id))) return false;
      return true;
    }

    /* ---------- perfil de gosto (aprende com o uso) ---------- */
    _carregarUsuario() {
      const d = (this._store && this._store.get(this._chave)) || {};
      return { v: d.v || {}, norma: d.norma || 0, hist: d.hist || {}, n: d.n || 0,
               perfil: d.perfil || {}, restricoes: d.restricoes || [], alergias: d.alergias || [], metas: d.metas || null };
    }
    _salvar() { if (this._store) this._store.set(this._chave, this.usuario); }
    _pref(r) {
      const u = this.usuario;
      let s = 0.5;
      if (u.norma > 0) {
        let d = 0; for (const [t, w] of r._v) { const x = u.v[t]; if (x) d += x * w; }
        s = 0.5 + 0.5 * clamp(d / u.norma, -1, 1);
      }
      const h = u.hist[r.id] || 0;
      if (h < -0.5) s *= 0.25;
      return s;
    }
    /** Registra interação: 'ver' | 'curtir' | 'cozinhar' | 'descurtir'. O perfil decai 3% a cada evento (gosto recente pesa mais). */
    feedback(id, tipo = 'curtir') {
      const r = this._byId.get(String(id)), w = PESO_FEEDBACK[tipo];
      if (!r || w === undefined) return false;
      const u = this.usuario;
      for (const t in u.v) { u.v[t] *= 0.97; if (Math.abs(u.v[t]) < 0.01) delete u.v[t]; }
      for (const [t, x] of r._v) u.v[t] = (u.v[t] || 0) + w * x;
      u.norma = Math.sqrt(Object.values(u.v).reduce((s, x) => s + x * x, 0));
      u.hist[r.id] = (u.hist[r.id] || 0) + w;
      u.n++;
      this._salvar();
      return true;
    }
    definirPreferencias({ restricoes, alergias } = {}) {
      if (restricoes) this.usuario.restricoes = [...new Set(restricoes)];
      if (alergias) this.usuario.alergias = [...new Set(alergias.map(fold))];
      this._salvar();
    }
    resetarUsuario() {
      this.usuario = { v: {}, norma: 0, hist: {}, n: 0, perfil: {}, restricoes: [], alergias: [], metas: null };
      this.ctx = { ultimos: [], vistos: new Set(), ultimaBusca: null, foco: null };
      this._salvar();
    }

    /* ---------- saída pública ---------- */
    _saida(r, extra = {}) {
      const o = Object.assign({}, r._o, { id: r.id, nome: r.nome, kcal: r.kcal, proteina: r.proteina, carbo: r.carbo, gordura: r.gordura,
        restricoes: Object.keys(r._flags).filter(k => r._flags[k]) }, extra);
      if (extra.porcoes && extra.porcoes !== 1) Object.assign(o, { kcalPorcao: Math.round(r.kcal * extra.porcoes), proteinaPorcao: r1(r.proteina * extra.porcoes) });
      return o;
    }
    _motivos(c) {
      const r = c.r, out = [];
      if (c.rel > 0.25) out.push('combina com o que você pediu');
      if (c.fit && c.fit.err < 0.18) out.push(`cabe na sua meta (~${Math.round(r.kcal * c.fit.m)} kcal)`);
      if (c.pref > 0.62) out.push('parecida com receitas que você curtiu');
      if (r._flags.proteico) out.push('rica em proteína');
      if (r.tempo && r.tempo <= 15) out.push(`pronta em ${r.tempo} min`);
      return out.slice(0, 3);
    }

    /* =================== API =================== */

    /** Busca tolerante a erros de digitação, sinônimos e plurais. */
    buscar(consulta = '', op = {}) {
      const { k = 10, offset = 0 } = op, f = this._filtros(op.filtros);
      const p = this._pontuar(consulta);
      const res = [];
      for (const r of this.R) {
        if (!this._passa(r, f)) continue;
        const sc = p ? p.s[r._i] : this._pref(r) + r.avaliacao / 50;
        if (p && sc <= 0.02) continue;
        res.push({ r, sc: p ? sc * (0.85 + 0.3 * this._pref(r)) : sc }); // personalização leve no ranking
      }
      res.sort((a, b) => b.sc - a.sc);
      return { resultados: res.slice(offset, offset + k).map(x => this._saida(x.r, { relevancia: r1(x.sc * 100) / 100 })),
               total: res.length, correcoes: p ? p.correcoes : [] };
    }

    /** Recomenda receitas combinando: relevância da busca + ajuste à meta + gosto do usuário + diversidade (MMR). */
    recomendar(op = {}) { return this._rank(op).itens; }
    _rank(op = {}) {
      const { k = 6, consulta, alvo, diversidade = 0.75, base } = op;
      const f = this._filtros({ ...op.filtros, refeicao: op.refeicao || (op.filtros || {}).refeicao });
      const p = consulta ? this._pontuar(consulta) : null;
      const cands = [];
      for (const r of this.R) {
        if (!this._passa(r, f) || (base && r === base)) continue;
        const rel = base ? this._sim(r, base) : p ? p.s[r._i] : 0;
        if ((p || base) && rel <= 0.02) continue;
        const pref = this._pref(r), fit = alvo ? ajuste(r, alvo) : null;
        const score = (p || base ? 0.5 * rel : 0) + (fit ? 0.35 * fit.fit : 0) + 0.3 * pref + 0.04 * r.avaliacao / 5;
        cands.push({ r, score, fit, pref, rel });
      }
      cands.sort((a, b) => b.score - a.score);
      const pool = cands.slice(0, Math.max(k * 5, 20)), sel = [];
      while (sel.length < k && pool.length) {
        let bi = 0, bv = -Infinity;
        for (let i = 0; i < pool.length; i++) {
          let red = 0; for (const s of sel) red = Math.max(red, this._sim(pool[i].r, s.r));
          const v = diversidade * pool[i].score - (1 - diversidade) * red;
          if (v > bv) { bv = v; bi = i; }
        }
        sel.push(pool.splice(bi, 1)[0]);
      }
      return { itens: sel.map(c => this._saida(c.r, { porcoes: c.fit ? c.fit.m : 1, motivos: this._motivos(c) })),
               total: cands.length, correcoes: p ? p.correcoes : [] };
    }

    /** Receitas mais parecidas com uma receita (conteúdo). */
    parecidas(id, k = 5, filtros) {
      const base = this._byId.get(String(id));
      return base ? this.recomendar({ base, k, filtros, diversidade: 0.85 }) : [];
    }

    /** Metas diárias (Mifflin-St Jeor). altura em cm ou m. */
    calcularMetas(p = {}) {
      const peso = num(p.peso), idade = num(p.idade);
      let altura = num(p.altura);
      if (altura && altura < 3) altura *= 100;
      const faltando = [!peso && 'peso', !altura && 'altura', !idade && 'idade'].filter(Boolean);
      if (faltando.length) return { erro: 'Faltam dados: ' + faltando.join(', '), faltando };
      const sexo = /^m/i.test(p.sexo || '') ? 'm' : 'f';
      const atividade = FATOR_ATIV[fold(p.atividade)] ? fold(p.atividade) : 'leve';
      const objetivo = ['perder', 'ganhar', 'manter'].includes(p.objetivo) ? p.objetivo : 'manter';
      const tmb = 10 * peso + 6.25 * altura - 5 * idade + (sexo === 'm' ? 5 : -161);
      const get = tmb * FATOR_ATIV[atividade];
      let kcal = get * (objetivo === 'perder' ? 0.8 : objetivo === 'ganhar' ? 1.1 : 1);
      kcal = Math.max(kcal, sexo === 'm' ? 1500 : 1200);
      const proteina = Math.min(peso * (objetivo === 'manter' ? 1.4 : 1.8), kcal * 0.35 / 4);
      let gordura = kcal * 0.27 / 9;
      let carbo = (kcal - proteina * 4 - gordura * 9) / 4;
      if (carbo < 130) { gordura = Math.max(kcal * 0.2 / 9, gordura - (130 - carbo) * 4 / 9); carbo = (kcal - proteina * 4 - gordura * 9) / 4; }
      const imc = peso / Math.pow(altura / 100, 2);
      const imcClasse = imc < 18.5 ? 'abaixo do peso' : imc < 25 ? 'peso normal' : imc < 30 ? 'sobrepeso' : imc < 35 ? 'obesidade grau I' : imc < 40 ? 'obesidade grau II' : 'obesidade grau III';
      const avisos = ['Estimativa educativa — não substitui nutricionista.'];
      if (idade < 18) avisos.push('Para menores de 18 anos as necessidades são diferentes; procure um profissional.');
      if (objetivo === 'perder' && kcal <= (sexo === 'm' ? 1500 : 1200)) avisos.push('Meta no limite mínimo seguro.');
      return { kcal: Math.round(kcal), proteina: Math.round(proteina), carbo: Math.round(carbo), gordura: Math.round(gordura),
               tmb: Math.round(tmb), gastoTotal: Math.round(get), fibras: Math.round(kcal / 1000 * 14), aguaMl: Math.round(peso * 35),
               imc: r1(imc), imcClasse, perfil: { peso, altura, idade, sexo, atividade, objetivo }, avisos };
    }

    /** Gera cardápio otimizado: escolha gulosa + busca local trocando receitas/porções para minimizar o erro de macros do dia. */
    gerarCardapio(op = {}) {
      const metas = op.metas || this.usuario.metas || { kcal: 2000, proteina: 100, carbo: 250, gordura: 60 };
      const dias = op.dias || 7, variedade = op.variedade ?? 0.08;
      const refs = (op.refeicoes || ['cafe', 'almoco', 'lanche', 'jantar']).map(normRefeicao);
      const somaDiv = refs.reduce((s, r) => s + ((op.divisao || {})[r] || DIVISAO[r] || 0.15), 0);
      const rand = rng(op.semente ?? Date.now());
      const f = this._filtros(op.filtros);
      const slots = refs.map(ref => {
        const alvo = escala(metas, ((op.divisao || {})[ref] || DIVISAO[ref] || 0.15) / somaDiv);
        let cands = this.R.filter(r => this._passa(r, f) && (!r.refeicao.length || r.refeicao.includes(ref)));
        if (!cands.length) cands = this.R.filter(r => this._passa(r, f));
        const pool = cands.map(r => { const a = ajuste(r, alvo), pref = this._pref(r); return { r, m: a.m, pref, base: a.fit + 0.25 * pref }; })
                          .sort((a, b) => b.base - a.base).slice(0, 30);
        return { ref, alvo, pool };
      });
      if (slots.some(s => !s.pool.length)) return { erro: 'Nenhuma receita atende aos filtros escolhidos.', dias: [] };

      const uso = new Map(), plano = [];
      const totais = esc => { const t = { kcal: 0, proteina: 0, carbo: 0, gordura: 0 }; for (const x of esc) for (const k of MACROS) t[k] += x.r[k] * x.m; return t; };
      const custo = esc => {
        let c = erroMacro(totais(esc), metas); const vistos = new Set();
        for (const x of esc) { c += variedade * (uso.get(x.r.id) || 0) + 0.05 * (1 - x.pref); if (vistos.has(x.r.id)) c += 1; vistos.add(x.r.id); }
        return c;
      };
      for (let d = 0; d < dias; d++) {
        const hoje = new Set();
        let esc = slots.map(s => { // 1) escolha gulosa com ruído (variedade)
          let best = s.pool[0], bv = -Infinity;
          for (const c of s.pool) {
            const v = c.base - 0.35 * (uso.get(c.r.id) || 0) - (hoje.has(c.r.id) ? 5 : 0) + rand() * 0.2;
            if (v > bv) { bv = v; best = c; }
          }
          hoje.add(best.r.id);
          return { r: best.r, m: best.m, pref: best.pref };
        });
        let atual = custo(esc); // 2) busca local (hill climbing) em receitas e porções
        for (let passe = 0; passe < 3; passe++) {
          let melhorou = false;
          for (let i = 0; i < esc.length; i++) for (const c of slots[i].pool.slice(0, 15)) for (const dm of [-0.25, 0, 0.25]) {
            const tent = esc.slice(); tent[i] = { r: c.r, m: clamp(c.m + dm, 0.5, 2), pref: c.pref };
            const v = custo(tent);
            if (v < atual - 1e-9) { atual = v; esc = tent; melhorou = true; }
          }
          if (!melhorou) break;
        }
        esc.forEach(x => uso.set(x.r.id, (uso.get(x.r.id) || 0) + 1));
        const t = totais(esc);
        plano.push({
          dia: d + 1,
          refeicoes: esc.map((x, i) => ({ refeicao: slots[i].ref, rotulo: ROTULO_REF[slots[i].ref] || slots[i].ref, porcoes: x.m,
            kcal: Math.round(x.r.kcal * x.m), proteina: r1(x.r.proteina * x.m), carbo: r1(x.r.carbo * x.m), gordura: r1(x.r.gordura * x.m),
            receita: this._saida(x.r) })),
          totais: { kcal: Math.round(t.kcal), proteina: Math.round(t.proteina), carbo: Math.round(t.carbo), gordura: Math.round(t.gordura) },
          aderencia: Math.round(clamp(1 - erroMacro(t, metas), 0, 1) * 100),
        });
      }
      const med = k => Math.round(plano.reduce((s, d) => s + d.totais[k], 0) / plano.length);
      const cardapio = { metas, dias: plano,
        resumo: { kcal: med('kcal'), proteina: med('proteina'), carbo: med('carbo'), gordura: med('gordura'),
                  aderencia: Math.round(plano.reduce((s, d) => s + d.aderencia, 0) / plano.length), receitasDiferentes: uso.size } };
      cardapio.listaCompras = this.listaCompras(cardapio);
      return cardapio;
    }

    /** Lista de compras somando ingredientes (escalados pela porção) de um cardápio. */
    listaCompras(cardapio) {
      const itens = new Map(), aGosto = new Map();
      for (const d of cardapio.dias) for (const ref of d.refeicoes) {
        const r = this._byId.get(String(ref.receita.id)), fator = ref.porcoes / r.porcoes;
        for (const linha of r._ing) {
          const lf = fold(linha).trim(), m = lf.match(RE_ING);
          if (!m) { const key = tokens(lf).join(' ') || lf; if (!aGosto.has(key)) aGosto.set(key, linha.trim()); continue; }
          const q = m[1].includes('/') ? m[1].split('/').reduce((a, b) => a / b) : NUMPAL[m[1]] ?? num(m[1]);
          const [u, mult] = unidade(m[2]);
          const nome = linha.trim().slice(linha.trim().length - m[3].length);
          const key = tokens(m[3]).join(' ') + '|' + u;
          const it = itens.get(key) || { item: nome, unidade: u, qtd: 0 };
          it.qtd += q * mult * fator; itens.set(key, it);
        }
      }
      const lista = [...itens.values()].map(it => ({ item: it.item, quantidade: fmtQtd(it.qtd, it.unidade) }))
        .sort((a, b) => a.item.localeCompare(b.item, 'pt'));
      for (const [k, txt] of aGosto) if (![...itens.keys()].some(x => x.startsWith(k.split(' ')[0]))) lista.push({ item: txt, quantidade: 'a gosto' });
      return lista;
    }

    /** Sugestões de substituição saudável para um ingrediente. */
    substituir(texto) {
      const t = fold(texto);
      return SUBST.filter(([re]) => re.test(t)).map(([, nome, opcoes]) => ({ ingrediente: nome, opcoes }));
    }

    /* =================== ASSISTENTE (CHAT) =================== */
    _intencao(t, e) {
      const palavras = t.split(/\s+/).length;
      if (/^(oi+|ola|bom dia|boa tarde|boa noite|e ai|opa|hey|hello|salve)\b/.test(t) && palavras <= 4) return ['saudacao', 1];
      if (/\b(nao (gostei|curti|gosto dess|quero ess)|odiei|eca)\b/.test(t)) return ['nao_gostei', 1];
      if (/^(gostei|adorei|amei|curti|essa e boa|que delicia)/.test(t)) return ['gostei', 1];
      if (/^(obrigad|valeu|vlw|brigad)/.test(t)) return ['agradecer', 1];
      if (/cardapio|dieta|plano alimentar|planejamento|menu (da|para|semanal)|refeicoes da semana/.test(t)) return ['cardapio', 1];
      if (/substitu|no lugar d|\btroca(r)?\b|alternativa (a|ao|para|pro)|ao inves d|em vez d/.test(t)) return ['substituir', 1];
      if (/parecid|similar|semelhante|tipo ess|igual a/.test(t)) return ['parecida', 1];
      if ((e.peso && (e.altura || e.idade)) ||
          /(quant[oa]s?|calcul\w*|qual|minhas?|meus?)\b.*\b(calorias|kcal|proteinas?|macros|carboidratos?|tmb|imc|gasto)\b.*\b(preciso|devo|necessit\w*|diari\w*|por dia|meus?|minhas?|eu)\b|calcul\w* (minhas?|meus?)|\bmeu (imc|gasto|metabolismo)|taxa metabolica|minha meta/.test(t)) return ['metas', 1];
      if (/^(mais( opcoes| sugestoes| receitas)?|outras?( opcoes)?|proxim[ao]s?|mostra mais|manda mais|tem outr\w*|outra opcao)$/.test(t)) return ['mais', 1];
      if (e.permanente && !/receita|quero|sugest|cardapio|indica|almoc|jant|lanche|cafe/.test(t)) return ['preferencia', 1];
      if (/(quant[ao]s? (calorias|kcal|proteinas?|carboidratos?|gorduras?|carbo)|informac\w* nutricion|tabela nutricion|valor (calorico|nutricional)|macros d)/.test(t)) return ['nutricao', 1];
      const nb = classificarNB(this._nb, t);
      if (nb.intent && nb.conf >= 0.45) return [nb.intent, nb.conf];
      if (tokens(limparConsulta(t)).some(x => this.idf.has(x)) || e.refeicao || e.restricoes.length) return ['buscar', 0.6];
      return nb.intent && nb.conf >= 0.25 ? [nb.intent, nb.conf] : ['desconhecido', nb.conf];
    }
    _resolver(t, e) {
      if (e.ordem != null) return this.ctx.ultimos[e.ordem] || null;
      if (/\b(dessa|essa|desta|esta|ela|dela|isso|disso|desse|esse)\b/.test(t) && this.ctx.foco) return this.ctx.foco;
      const p = this._pontuar(limparConsulta(t));
      if (p) {
        let bi = -1, bv = 0.12;
        for (let i = 0; i < this.N; i++) if (p.s[i] > bv) { bv = p.s[i]; bi = i; }
        if (bi >= 0) return this.R[bi];
      }
      return this.ctx.foco || this.ctx.ultimos[0] || null;
    }
    _mostrar(itens) {
      this.ctx.ultimos = itens.map(x => this._byId.get(String(x.id)));
      this.ctx.foco = this.ctx.ultimos[0] || this.ctx.foco;
      for (const x of itens) this.ctx.vistos.add(String(x.id)); // 'ver' só quando o usuário abre a receita no site
    }
    _alvoRefeicao(ref) {
      const m = this.usuario.metas;
      return m ? escala(m, ref ? (DIVISAO[ref] || 0.25) : 0.3) : null;
    }

    /** Responde a uma mensagem em linguagem natural. Retorna { intent, confianca, texto, receitas?, cardapio?, metas?, substituicoes?, sugestoes }. */
    responder(mensagem) {
      const t = fold(mensagem).replace(/[!?;:"'()*]/g, ' ').replace(/\s+/g, ' ').trim();
      const e = extrair(t), u = this.usuario;
      // memória: dados corporais e restrições permanentes
      for (const k of ['peso', 'altura', 'idade', 'sexo', 'atividade', 'objetivo']) if (e[k] != null) u.perfil[k] = e[k];
      if (e.permanente) {
        u.restricoes = [...new Set(u.restricoes.concat(e.restricoes.filter(x => x !== 'low_carb' && x !== 'proteico')))];
        u.alergias = [...new Set(u.alergias.concat(e.excluir))];
      }
      if (u.perfil.peso && u.perfil.altura && u.perfil.idade) u.metas = this.calcularMetas(u.perfil);
      this._salvar();

      const [intent, conf] = this._intencao(t, e);
      const out = r => Object.assign({ intent, confianca: r1(conf * 100) / 100, sugestoes: [] }, r);
      const nomes = () => this.ctx.ultimos.map(r => r.nome);

      switch (intent) {
        case 'saudacao':
          return out({ texto: 'Olá! 👋 Sou o assistente de receitas. Posso sugerir receitas, calcular suas metas diárias, montar um cardápio e indicar trocas saudáveis.',
                       sugestoes: ['Quero um jantar leve', 'Calcular minhas calorias', 'Monte um cardápio da semana'] });
        case 'ajuda':
          return out({ texto: 'Você pode me pedir, por exemplo:\n• "receita vegana com grão-de-bico em até 30 min"\n• "tenho 68 kg, 1,65 m, 29 anos, mulher, treino 3x por semana, quero emagrecer"\n• "monte um cardápio de 5 dias sem lactose"\n• "o que usar no lugar do açúcar?"\n• "quantas calorias tem a segunda?"\nE é só dizer "gostei" ou "não gostei" para eu aprender seu gosto.',
                       sugestoes: ['Receita rica em proteína', 'Calcular minhas calorias', 'Substituir farinha de trigo'] });
        case 'agradecer':
          return out({ texto: 'Por nada! Bom apetite 🥗', sugestoes: ['Mais receitas', 'Monte um cardápio'] });
        case 'preferencia': {
          const itens = u.restricoes.map(x => ROTULO_RESTR[x]).concat(u.alergias.map(x => 'sem ' + x));
          return out({ texto: `Anotado! A partir de agora todas as sugestões e cardápios serão: ${itens.join(', ') || 'sem restrições'}.`,
                       sugestoes: ['Sugira um almoço', 'Monte um cardápio'] });
        }

        case 'metas': {
          const p = u.perfil, falta = [!p.peso && 'peso', !p.altura && 'altura', !p.idade && 'idade'].filter(Boolean);
          if (falta.length) return out({ texto: `Para calcular preciso de: ${falta.join(', ')}. Ex.: "70 kg, 1,75 m, 30 anos, homem, treino 4x por semana, quero emagrecer".`, faltando: falta });
          const m = u.metas;
          const obj = { perder: 'emagrecer', ganhar: 'ganhar massa', manter: 'manter o peso' }[m.perfil.objetivo];
          return out({ metas: m,
            texto: `Sua meta diária para ${obj}: **${m.kcal} kcal** — ${m.proteina} g de proteína, ${m.carbo} g de carboidrato e ${m.gordura} g de gordura. ` +
                   `Água: ~${(m.aguaMl / 1000).toFixed(1).replace('.', ',')} L. IMC ${String(m.imc).replace('.', ',')} (${m.imcClasse}).` +
                   (p.sexo ? '' : ' (Considerei sexo feminino — diga "sou homem" para ajustar.)') +
                   (e.atividade || p.atividade ? '' : ' (Considerei atividade leve — diga quantas vezes treina por semana.)') +
                   '\n⚠️ ' + m.avisos.join(' '),
            sugestoes: ['Monte um cardápio pra mim', 'Sugira um almoço que caiba na meta'] });
        }

        case 'cardapio': {
          const metas = u.metas || null;
          const c = this.gerarCardapio({ metas: metas || undefined, dias: e.dias || 7,
            filtros: { restricoes: e.restricoes.filter(x => x !== 'proteico'), excluirIngredientes: e.excluir } });
          if (c.erro) return out({ texto: c.erro + ' Tente com menos restrições.' });
          const d1 = c.dias[0].refeicoes.map(r => `${r.rotulo}: ${r.receita.nome}${r.porcoes !== 1 ? ` (${String(r.porcoes).replace('.', ',')}x)` : ''}`).join('\n');
          return out({ cardapio: c,
            texto: `Montei ${c.dias.length} dia(s) com média de ${c.resumo.kcal} kcal e ${c.resumo.proteina} g de proteína (aderência à meta: ${c.resumo.aderencia}%, ${c.resumo.receitasDiferentes} receitas diferentes).` +
                   (metas ? '' : ' Usei uma meta padrão de 2000 kcal — me diga peso, altura e idade para personalizar.') + `\n\nDia 1:\n${d1}`,
            sugestoes: ['Gerar outro cardápio', 'Cardápio sem lactose', 'Calcular minhas calorias'] });
        }

        case 'substituir': {
          const s = this.substituir(t);
          if (!s.length) return out({ texto: 'Ainda não tenho uma troca cadastrada para isso. Tente: açúcar, farinha de trigo, leite, ovo, manteiga, arroz, creme de leite, macarrão, queijo...' });
          return out({ substituicoes: s, texto: s.map(x => `No lugar de ${x.ingrediente}: ${x.opcoes.join('; ')}.`).join('\n') });
        }

        case 'nutricao': {
          const r = this._resolver(t, e);
          if (!r) return out({ texto: 'De qual receita? Diga o nome ou "a primeira", "a segunda"...' });
          this.ctx.foco = r;
          const m = u.metas, pct = m ? ` (${Math.round(r.kcal / m.kcal * 100)}% da sua meta diária)` : '';
          return out({ receitas: [this._saida(r)],
            texto: `${r.nome} (1 porção): ${r.kcal} kcal${pct} · ${r.proteina} g proteína · ${r.carbo} g carboidrato · ${r.gordura} g gordura` + (r.tempo ? ` · ${r.tempo} min` : '') + '.',
            sugestoes: ['Receita parecida com essa', 'Gostei dessa'] });
        }

        case 'parecida': {
          const base = this._resolver(t, e);
          if (!base) return out({ texto: 'Parecida com qual receita? Diga o nome ou peça uma busca primeiro.' });
          const itens = this.parecidas(base.id, 4);
          this.ctx.ultimaBusca = { base, k: 4 };
          this._mostrar(itens);
          return out({ receitas: itens, texto: `Receitas parecidas com ${base.nome}:`, sugestoes: ['Mais', 'Gostei da primeira'] });
        }

        case 'gostei':
        case 'nao_gostei': {
          const r = this._resolver(t, e);
          if (!r) return out({ texto: 'Anotado! Me mostre uma receita primeiro para eu saber qual.' });
          const curtiu = intent === 'gostei';
          this.feedback(r.id, curtiu ? 'curtir' : 'descurtir');
          if (curtiu) {
            const itens = this.parecidas(r.id, 3);
            this._mostrar(itens);
            return out({ receitas: itens, texto: `Que bom! Vou priorizar receitas no estilo de ${r.nome}. Talvez você goste destas:` });
          }
          const ub = this.ctx.ultimaBusca || {};
          const itens = this.recomendar({ ...ub.op, k: 3, filtros: { ...(ub.op || {}).filtros, excluirIds: new Set([...this.ctx.vistos]) } });
          this._mostrar(itens);
          return out({ receitas: itens, texto: `Anotado, vou mostrar menos receitas como ${r.nome}.` + (itens.length ? ' Que tal estas?' : '') });
        }

        case 'mais': {
          const ub = this.ctx.ultimaBusca;
          if (!ub) return out({ texto: 'Mais do quê? Peça uma receita primeiro 🙂' });
          const excluirIds = new Set([...this.ctx.vistos]);
          const itens = ub.base ? this.recomendar({ base: ub.base, k: 4, filtros: { excluirIds } })
                                : this.recomendar({ ...ub.op, filtros: { ...ub.op.filtros, excluirIds } });
          if (!itens.length) return out({ texto: 'Acabaram as opções com esses critérios. Quer tentar outra busca?' });
          this._mostrar(itens);
          return out({ receitas: itens, texto: 'Mais opções:', sugestoes: ['Mais', 'Gostei da primeira'] });
        }

        case 'buscar':
        case 'desconhecido': {
          const consulta = limparConsulta(t);
          const temTermo = tokens(consulta).some(x => this._corrigir(x));
          if (intent === 'desconhecido' && !temTermo) {
            return out({ texto: 'Não entendi bem 😅. Tente "receita com frango", "calcular minhas calorias" ou "monte um cardápio".',
                         sugestoes: ['Ajuda', 'Receita rápida', 'Calcular minhas calorias'] });
          }
          const filtros = { restricoes: e.restricoes, excluirIngredientes: e.excluir, maxTempo: e.maxTempo, maxKcal: e.maxKcal, refeicao: e.refeicao };
          let alvo = this._alvoRefeicao(e.refeicao);
          if (alvo && e.maxKcal && alvo.kcal > e.maxKcal) alvo = escala(alvo, e.maxKcal / alvo.kcal); // "leve"/"até X kcal" limita a porção
          const op = { k: 4, consulta: temTermo ? consulta : null, alvo, refeicao: e.refeicao, filtros };
          let res = this._rank(op), relaxou = '';
          if (!res.itens.length && (filtros.maxTempo || filtros.maxKcal || filtros.refeicao)) {
            op.filtros = { restricoes: e.restricoes, excluirIngredientes: e.excluir }; op.refeicao = null;
            res = this._rank(op); relaxou = ' (afrouxei tempo/calorias/refeição para encontrar algo)';
          }
          this.ctx.ultimaBusca = { op };
          this._mostrar(res.itens);
          if (!res.itens.length) return out({ texto: 'Não encontrei receitas com esses critérios. Quer tentar com menos restrições?' });
          const corr = res.correcoes.length ? ` Entendi ${res.correcoes.map(([a, b]) => `"${b}" (você escreveu "${a}")`).join(', ')}.` : '';
          const filtTxt = [...new Set(e.restricoes.concat(u.restricoes))].map(x => ROTULO_RESTR[x]).filter(Boolean);
          return out({ intent: 'buscar', receitas: res.itens,
            texto: `Separei ${res.itens.length} opção(ões)${filtTxt.length ? ' ' + filtTxt.join(', ') : ''}${e.refeicao ? ' para o ' + (ROTULO_REF[e.refeicao] || e.refeicao).toLowerCase() : ''}` +
                   `${u.metas ? ', ajustadas à sua meta' : ''}:${relaxou}${corr}`,
            sugestoes: ['Mais', 'Quantas calorias tem a primeira?', 'Receita parecida com a primeira'] });
        }
      }
      return out({ texto: 'Não entendi.' });
    }

    /** Igual a responder(), mas usa um LLM externo (opcional) quando a IA local não entende. opcoes.llm = async ({ sistema, mensagem, contexto }) => string */
    async responderAsync(mensagem) {
      const r = this.responder(mensagem);
      if (!this.llm || (r.intent !== 'desconhecido' && r.confianca >= 0.45)) return r;
      const contexto = {
        metas: this.usuario.metas && { kcal: this.usuario.metas.kcal, proteina: this.usuario.metas.proteina },
        restricoes: this.usuario.restricoes,
        receitasSugeridas: this.recomendar({ k: 5, consulta: mensagem }).map(x => ({ id: x.id, nome: x.nome, kcal: x.kcal, proteina: x.proteina })),
      };
      try {
        r.texto = await this.llm({ mensagem, contexto,
          sistema: 'Você é o assistente de um site de alimentação saudável. Responda em português, de forma breve, e só recomende receitas presentes em contexto.receitasSugeridas. Não dê diagnóstico médico.' });
        r.fonte = 'llm';
      } catch (_) { /* mantém a resposta local */ }
      return r;
    }
  }

  NutriAI.util = { fold, tokens, terms, stem, lev, extrair, classificarNB };
  return NutriAI;
});
