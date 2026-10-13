# 🥗 NutriAI — IA para site de receitas saudáveis

Inteligência artificial leve, em **JavaScript puro**, para um site de alimentação saudável com 150 receitas. Roda direto no navegador: não precisa de servidor, de instalação nem de API paga.

## O que ela faz
- **Busca inteligente:** entende erros de digitação ("frnago" vira "frango"), plurais e sinônimos.
- **Recomendações personalizadas:** aprende o gosto de cada pessoa com 👍/👎.
- **Calculadora de metas:** calorias, proteínas, carboidratos e gorduras por peso, altura, idade e objetivo.
- **Cardápio automático:** monta a semana batendo a meta diária, ajusta as porções e gera a lista de compras.
- **Chat em português:** "quero um jantar vegano rápido", "o que usar no lugar do açúcar?", "não como carne".

## Como ver funcionando
Baixe o projeto (botão verde **Code → Download ZIP**), descompacte e dê **dois cliques em `demo.html`**.

## Arquivos
| Arquivo | O que é |
|---|---|
| `nutri-ai.js` | O motor da IA. É o arquivo que vai para o site |
| `receitas-exemplo.js` | 32 receitas de teste, a trocar pelas 150 reais |
| `demo.html` | Página de demonstração |
| `CLAUDE.md` | Documentação técnica completa: decisões, funções e próximos passos |

## Como continuar o projeto com o Claude Code
Abra esta pasta no [Claude Code](https://claude.com/claude-code) (app ou terminal). O Claude lê o `CLAUDE.md` automaticamente e já sabe o histórico do projeto. Para começar, peça algo como:

> Leia o CLAUDE.md e me diga quais são os próximos passos.

## Uso no site
```html
<script src="nutri-ai.js"></script>
<script>
  const ia = new NutriAI(receitas);
  ia.responder('quero um almoço rico em proteína');
</script>
```

> ⚠️ Os cálculos nutricionais são estimativas educativas e não substituem um nutricionista.
