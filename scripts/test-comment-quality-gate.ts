import { validateCommentGrounding } from './comment-generator';
import { detectPostIntent } from './tattoo-voice';

const check = (name: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
  console.log(`ok - ${name}`);
};

check('rejects leaf claim against ship evidence', validateCommentGrounding(
  'that leaf detail is so clean',
  { caption: 'by @artist #tattoo', visionDescription: 'subject: two sailing ships and an ornate cross (high) | observed craft: fine linework in the rigging' },
), false);
check('rejects unverified shading without vision', validateCommentGrounding(
  'the shading in those folds is so smooth',
  { caption: 'new tattoo from today', visionDescription: '' },
), false);
check('accepts caption-grounded freehand lettering', validateCommentGrounding(
  'freehanding that script across the back takes real confidence',
  { caption: 'Had fun freehanding the homie’s last name across his back #LetteringTattoo', visionDescription: '' },
), true);
check('rejects repeated template language', validateCommentGrounding(
  'that pencil to paper sentiment hits different for real',
  { caption: 'Pencil to paper, nothing compares', visionDescription: '' },
), false);
check('promotional first-tattoo wording stays non-milestone',
  detectPostIntent('Whether it is your first tattoo or the next piece in your collection, our artists are ready.').intent === 'first_tattoo',
  false,
);
check('real first tattoo remains a milestone',
  detectPostIntent('Her first tattoo today and she sat like a champ.').intent === 'first_tattoo',
  true,
);
