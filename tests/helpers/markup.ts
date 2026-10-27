import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export const escapeText = (value: string) =>
  renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);
