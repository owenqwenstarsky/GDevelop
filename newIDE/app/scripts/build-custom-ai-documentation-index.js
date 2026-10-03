// Usage: node scripts/build-custom-ai-documentation-index.js /path/to/GDevelop-documentation
// Generates a reproducible English text index from the official documentation source.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const source = path.resolve(process.argv[2]);
const root = path.join(source, 'docs', 'gdevelop5');
const pages = [];
const visit = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith('.md')) {
      const markdown = fs.readFileSync(file, 'utf8');
      const relative = path
        .relative(root, file)
        .replace(/\\/g, '/')
        .replace(/\.md$/, '')
        .replace(/\/index$/, '');
      const text = markdown
        .replace(/^---[\s\S]*?---/, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      pages.push({
        title: (text.match(/^#+\s+(.+)$/m) || [null, relative])[1],
        url: 'https://wiki.gdevelop.io/gdevelop5/' + relative + '/',
        text,
      });
    }
  }
};
visit(root);
pages.sort((a, b) => a.url.localeCompare(b.url));
const licenseFiles = fs
  .readdirSync(source)
  .filter(name => /^licen[sc]e/i.test(name));
const index = {
  attribution:
    'GDevelop documentation contributors. Source: https://github.com/GDevelopApp/GDevelop-documentation. See DocumentationLicense.txt.',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim(),
  pages,
};
const output = path.join(__dirname, '../src/AiGeneration/Providers');
fs.writeFileSync(
  path.join(output, 'DocumentationIndex.json'),
  JSON.stringify(index) + '\n'
);
fs.writeFileSync(
  path.join(output, 'DocumentationLicense.txt'),
  'GDevelop documentation contributors\nSource: https://github.com/GDevelopApp/GDevelop-documentation\nExcept where otherwise noted, the bundled documentation text is licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).\nhttps://creativecommons.org/licenses/by-sa/4.0/\nThe index strips image and HTML markup; text is otherwise derived from the official source.\n' +
    licenseFiles
      .map(name => fs.readFileSync(path.join(source, name), 'utf8'))
      .join('\n')
);
console.log(
  `Indexed ${pages.length} English documentation pages at ${
    index.sourceRevision
  }.`
);
