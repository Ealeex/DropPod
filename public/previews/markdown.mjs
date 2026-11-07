let markdown;

export async function renderMarkdown(text) {
  markdown ||= import('/vendor/preview/markdown-it.mjs').then(({ default: createMarkdown }) => {
    const parser = createMarkdown({ html: false });
    const validateLink = parser.validateLink;
    parser.validateLink = (url) => validateLink(url) && /^(?:https?:\/\/|mailto:)/i.test(url);
    parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index].content);
    parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
      tokens[index].attrSet('target', '_blank');
      tokens[index].attrSet('rel', 'noopener noreferrer');
      return renderer.renderToken(tokens, index, options);
    };
    return parser;
  });
  const article = document.createElement('article');
  article.className = 'preview-markdown';
  article.innerHTML = (await markdown).render(text);
  return article;
}
