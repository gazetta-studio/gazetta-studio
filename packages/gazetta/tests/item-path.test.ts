import { describe, expect, it } from 'vitest'
import { parseItemPath } from '../src/item-name.js'

describe('parseItemPath (#1200)', () => {
  it.each([
    ['pages/home', { folder: 'pages', name: 'home' }],
    ['pages/blog/post:fr', { folder: 'pages', name: 'blog/post', locale: 'fr' }],
    ['fragments/header:pt-br', { folder: 'fragments', name: 'header', locale: 'pt-br' }],
    ['templates/hero', { folder: 'templates', name: 'hero' }],
    ['assets/hero', { folder: 'assets', name: 'hero' }],
    ['hero', { folder: null, name: 'hero' }],
  ])('parses %s', (item, expected) => {
    expect(parseItemPath(item)).toEqual(expected)
  })

  it.each([
    'pages/../secret',
    'fragments/./x',
    '/pages/home',
    'pages\\home',
    'pages/',
    'pages/home:not a locale',
    'pages/home:',
    '..',
  ])('rejects %s', item => {
    expect(parseItemPath(item)).toBeNull()
  })
})
