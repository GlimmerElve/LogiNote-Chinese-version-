import './scene-pack-test-bootstrap';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) throw new Error('Missing scene check entry');
process.argv.splice(1, 2, path.resolve(target));
await import(pathToFileURL(path.resolve(target)).href);
