# NutriAI — IA para site de alimentação saudável

## Objetivo
Adicionar inteligência a um site de alimentação saudável que já tem 150 receitas, uma página de cardápio e uma calculadora de calorias/macros (por peso, altura e idade). A IA deve deixar o uso mais **eficiente** (achar a receita certa rápido, montar cardápio sozinha) e mais **interativo** (chat em português, recomendações que aprendem o gosto de cada pessoa).

Requisito do usuário: um modelo **simples e otimizado em JavaScript**.

## Passagem do projeto
O projeto foi passado adiante: quem criou não vai mais mexer, e o novo responsável continua daqui. Tudo o que foi decidido está neste arquivo. A conversa original não acompanha o projeto.

## Como rodar
- **Mais simples:** dar dois cliques em `demo.html`. Abre no navegador sem instalar nada.
- **Com servidor local** (opcional, simula o site real): na pasta do projeto, rodar `python -m http.server 8765` e abrir `http://localhost:8765/demo.html`. No Claude Code, a configuração já está em `.claude/launch.json`.
- **Para usar no site:** incluir `<script src="nutri-ai.js"></script>` e criar `new NutriAI(receitas)`.

## Decisões tomadas
- **JavaScript puro, zero dependências, 100% no navegador.** Sem servidor e sem API paga. Arquivo único (`nutri-ai.js`), compatível com `<script>` (global `NutriAI`) e CommonJS (`module.exports`).
- **IA clássica e leve em vez de um LLM.** Busca TF-IDF, Naive Bayes, regras de texto e otimização por busca local. Responde em menos de 2 ms e o cardápio de 7 dias sai em cerca de 3 ms. Com 150 receitas, não precisa de nada mais pesado.
- **LLM só como opcional.** `responderAsync` aceita `opcoes.llm` (função async) e só o chama quando a IA local não entende a pergunta. O LLM recebe apenas receitas do catálogo como contexto, para não inventar receitas.
- **Português do Brasil.** Texto normalizado sem acentos, stemmer leve de plural, sinônimos regionais (aipim = mandioca, galinha = frango) e palavras de medida ignoradas ("colher de sopa").
- **Restrições inferidas dos ingredientes**, com exceções (leite de coco não tem lactose; farinha de arroz não tem glúten). Tags explícitas na receita têm prioridade.
- **Valores nutricionais por porção.** O cardápio ajusta a porção de 0,5x a 2x, em passos de 0,25.
- **Metas pela fórmula de Mifflin-St Jeor.** Fatores de atividade de 1,2 a 1,9. Emagrecer = −20%, ganhar = +10%. Proteína de 1,8 g/kg (perder/ganhar) ou 1,4 g/kg (manter). Gordura em 27% das kcal e carboidrato com o resto (mínimo de 130 g). Piso de 1.200 kcal (f) / 1.500 kcal (m). Sempre mostra o aviso de estimativa educativa e um alerta para menores de 18 anos.
- **Gosto do usuário salvo em `localStorage`** (chave `nutriai:usuario`). O armazenamento pode ser trocado via `opcoes.armazenamento` (`{get, set}` ou `null`).
- **Só mostrar uma receita não conta como interesse.** O feedback `'ver'` deve ser chamado pelo site quando a pessoa abre a receita.
- **"Não como X" / "sou vegano" viram preferência permanente.** Restrições ditas dentro de um pedido ("jantar vegano") valem só para aquela busca.

## Estrutura dos arquivos
| Arquivo | Conteúdo |
|---|---|
| `nutri-ai.js` | Motor da IA (classe `NutriAI`) |
| `receitas-exemplo.js` | 32 receitas de teste em `window.RECEITAS`, a substituir pelas 150 reais |
| `demo.html` | Demonstração com chat, busca ao vivo, calculadora, cardápio e lista de compras |
| `.claude/launch.json` | Servidor local para testes (`python -m http.server 8765`; abrir `/demo.html`) |

### Seções de `nutri-ai.js`
1. Texto PT-BR: `fold`, `tokens`, `terms` (bigramas), `stem`, `SIN`, `EXPANDE` (salmão também é peixe), `lev` (Damerau/OSA com corte antecipado)
2. Restrições: `calcularFlags` (vegano, vegetariano, sem_lactose, sem_gluten, low_carb, proteico)
3. Nutrição: `erroMacro` (passar da meta de proteína pesa só 30%), `ajuste` (melhor porção), `FATOR_ATIV`, `DIVISAO` (café 25%, almoço 35%, lanche 12%, jantar 28%, ceia 8%)
4. Substituições saudáveis: tabela `SUBST`
5. Entendimento do chat: `TREINO` (frases de treino do Naive Bayes), `extrair` (lê peso, altura, idade, sexo, objetivo, atividade, refeição, restrições, ingredientes a excluir, tempo, kcal máximas, dias e "a primeira/segunda")
6. Lista de compras: `RE_ING`, `unidade`, `fmtQtd`
7. Armazenamento: `lsStore`
8. Classe `NutriAI`

### Formato da receita
```js
{ id, nome, ingredientes: ['150 g de peito de frango', ...], kcal, proteina, carbo, gordura,
  refeicao: ['almoco','jantar'], tags: ['vegano', ...], tempo /*min*/, porcoes /*default 1*/,
  categoria?, descricao?, avaliacao? /*0–5*/ }
```
Também aceita os nomes `calorias`, `proteinas`, `carboidratos` e `gorduras`, e ingredientes como objeto `{quantidade, nome}`.

## Funcionalidades implementadas (API pública)
- `buscar(consulta, {k, offset, filtros})`: busca tolerante a erros, plurais e sinônimos. Retorna `{resultados, total, correcoes}`.
- `recomendar({k, consulta, alvo, refeicao, filtros, diversidade})`: combina relevância (0,5), ajuste à meta (0,35), gosto do usuário (0,3) e avaliação. Usa um filtro para não sugerir receitas muito parecidas entre si. Cada item traz `porcoes` e `motivos`.
- `parecidas(id, k)`: receitas parecidas pelo conteúdo.
- `calcularMetas({peso, altura, idade, sexo, atividade, objetivo})`: kcal, macros, TMB, gasto total, fibras, água, IMC e avisos.
- `gerarCardapio({metas, dias, refeicoes, divisao, filtros, variedade, semente})`: primeiro escolhe a melhor receita para cada refeição, depois testa trocas de receita e de porção (até 3 passadas) para chegar mais perto da meta, penalizando repetição. Retorna os dias, o `resumo` (média e aderência %) e a `listaCompras`.
- `listaCompras(cardapio)`: soma os ingredientes por unidade, já escalados pela porção.
- `substituir(texto)`: trocas saudáveis.
- `feedback(id, 'ver'|'curtir'|'cozinhar'|'descurtir')`: atualiza o perfil de gosto. O gosto antigo perde 3% de peso a cada evento.
- `definirPreferencias({restricoes, alergias})` e `resetarUsuario()`.
- `responder(msg)`: chat. Intenções: saudacao, ajuda, agradecer, preferencia, buscar, mais, nutricao, parecida, gostei, nao_gostei, metas, cardapio, substituir, desconhecido. Retorna `{intent, confianca, texto, receitas?, cardapio?, metas?, substituicoes?, sugestoes}`.
- `responderAsync(msg)`: igual a `responder`, com o LLM opcional como reserva.
- `NutriAI.util`: funções internas expostas para testes.

## Testes e estado atual
- Não existe suíte de testes automatizados. Para testar, abra a `demo.html` e rode `ia.responder('...')` no console do navegador (F12). Na máquina original não havia Node.
- Bugs já corrigidos:
  - correção ortográfica aceitava palavras distantes demais;
  - "lata" era lida como litro;
  - "sopa" estava na lista de palavras ignoradas;
  - "não gosto de X" virava avaliação negativa em vez de preferência;
  - ordinal inexistente ("a segunda" com só 1 resultado) puxava receita errada;
  - "leve" ou "até X kcal" agora limitam a porção sugerida.
- Limite conhecido: com poucas receitas, metas altas (ex.: 3.000 kcal) ficam em ~90% de aderência porque a porção máxima é 2x.

## Próximos passos
- Trocar `receitas-exemplo.js` pelas 150 receitas reais e conferir as restrições inferidas (`ia.R.map(r => r._flags)`).
- Integrar ao site: chat flutuante, `buscar` na página de receitas, `gerarCardapio` na página de cardápio e `calcularMetas` na calculadora (guardando em `ia.usuario.metas`).
- Chamar `feedback(id, 'ver')` ao abrir uma receita e adicionar botões 👍/👎/"fiz".
- Ampliar `TREINO`, `SIN` e `SUBST` com perguntas reais dos usuários.
