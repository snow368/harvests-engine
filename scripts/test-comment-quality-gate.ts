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
check('rejects hollow critic-speak tail (2026-09-11 user report)', validateCommentGrounding(
  'greek statues hit different fr, that marble value work is a beast to get reading right',
  { caption: 'Portrait of Poseidon ❤️ Greek statues are one of my top 3 favorite thing to tattoo #poseidon #greekmythology', visionDescription: 'subject: Poseidon portrait with trident (high) | observed craft: smooth grey wash gradients' },
), false);
check('promotional first-tattoo wording stays non-milestone',
  detectPostIntent('Whether it is your first tattoo or the next piece in your collection, our artists are ready.').intent === 'first_tattoo',
  false,
);
check('real first tattoo remains a milestone',
  detectPostIntent('Her first tattoo today and she sat like a champ.').intent === 'first_tattoo',
  true,
);
check('rejects vision-only dotwork and healing hallucination', validateCommentGrounding(
  'dot work density on the snake scales still reads tight through inner thigh healing',
  {
    caption: '',
    visionDescription: 'hook: the dot-work on the snake scales shows good density | motif: traditional geisha with dragon and samurai with snake (high) | placement: inner thighs | stage: healed',
  },
), false);
check('accepts dotwork when artist caption explicitly names it', validateCommentGrounding(
  'the dotwork density stays even across the snake scales',
  {
    caption: 'Week healed snake, built with dotwork shading through the scales.',
    visionDescription: 'motif: snake (high) | placement: inner thigh',
  },
), true);
check('rejects peer putdown verdicts', validateCommentGrounding(
  'keeping that density even is where most people lose it',
  {
    caption: 'Week healed dotwork snake.',
    visionDescription: 'motif: snake (high) | placement: inner thigh',
  },
), false);
