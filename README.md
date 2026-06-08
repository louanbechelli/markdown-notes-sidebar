# Meu Bloco de Notas

Uma extensao open source para criar, editar e organizar notas Markdown diretamente na barra lateral do VS Code e Cursor.

As notas sao salvas como arquivos `.md` em uma pasta escolhida pelo usuario, facilitando backup, sincronizacao e uso.

## Como testar

1. Abra esta pasta no VS Code.
2. Pressione `F5`.
3. Se aparecer uma lista de configuracoes, escolha `Executar Extensao`.
4. Na janela nova do VS Code/Cursor, clique no icone `Notas` na barra lateral esquerda.
5. Se o icone nao aparecer, abra a paleta de comandos com `Ctrl+Shift+P` e rode `Meu Bloco de Notas: Abrir`.
6. Na engrenagem, escolha a pasta onde as notas serao lidas e salvas.
7. Clique em `+` para criar notas separadas. Cada nota vira um arquivo `.md`.
8. Renomeie a nota pelo titulo e escreva o conteudo no campo maior. Tudo e salvo automaticamente na pasta selecionada.
9. Use a engrenagem no topo da view para ajustar fonte, fonte manual e tamanho do texto.

> `F5` nao instala a extensao no editor atual. Ele abre uma janela temporaria de desenvolvimento chamada Extension Development Host.

## Como instalar no editor

### Opcao simples: instalar copiando a pasta

1. Feche o Cursor/VS Code.
2. Copie esta pasta inteira para a pasta de extensoes do seu editor:
   - Cursor: `%USERPROFILE%\.cursor\extensions\louan.meu-bloco-de-notas-0.0.1`
   - VS Code: `%USERPROFILE%\.vscode\extensions\louan.meu-bloco-de-notas-0.0.1`
3. Abra o editor de novo.
4. Clique no icone `Notas` na barra lateral esquerda.

### Opcao VSIX: instalar como pacote

1. Nesta pasta, gere o pacote:

```powershell
npx @vscode/vsce package
```

2. No Cursor/VS Code, abra a aba de extensoes.
3. Clique no menu `...`.
4. Escolha `Install from VSIX...`.
5. Selecione o arquivo `.vsix` gerado nesta pasta.
6. Reinicie o editor se ele pedir.

## Comandos

- `Meu Bloco de Notas: Abrir`
- `Meu Bloco de Notas: Criar nota`
- `Meu Bloco de Notas: Configuracoes`
- `Meu Bloco de Notas: Escolher pasta das notas`

## Arquivos principais

- `package.json`: manifest da extensao e contribuicoes para o VS Code.
- `src/extension.js`: registra a view e controla leitura, criacao, selecao, renomeacao e salvamento dos arquivos `.md`.
- `media/icon.svg`: icone usado na barra lateral.
