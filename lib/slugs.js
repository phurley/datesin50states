// Map slugs: adjective-verb-animal, e.g. "rapid-crawling-elk".
// 120 × 110 × 120 ≈ 1.6 million combinations. There's no user search, so a slug is
// effectively an unlisted link; unknown slugs are rate-limited in server.js.
import crypto from 'node:crypto';

const ADJECTIVES = `amber ancient bold brave breezy bright brisk bronze calm candid carefree cheery
chilly clever cozy crimson curious daring dapper dazzling dusty eager early easy electric
fancy fearless feisty fiery fluffy foggy frosty gentle giddy gilded golden graceful grand
happy hardy hazy hearty humble icy jaunty jolly jumpy keen kind lanky lazy lively lofty
lucky lunar mellow merry mighty misty modest mossy nimble noble peppy perky placid plucky
polished proud quick quiet quirky radiant rapid rosy rowdy rugged rustic salty sandy scenic
shady shiny silent silver sleepy slick smoky snappy snowy snug sparkly speedy spicy spry
starry steady stormy sturdy sunny swift tawny tidy timber tiny toasty trusty twilight velvet
vivid wandering warm whimsical wild windy wise witty woolly zesty zippy dreamy`.split(/\s+/);

const VERBS = `ambling bounding bouncing cartwheeling cavorting chasing climbing coasting crawling
cruising dancing darting dashing dawdling diving dozing drifting falling floating flying
foraging frolicking galloping gliding grazing hiking hooting hopping hovering howling
humming hurrying jogging juggling jumping leaping lounging marching meandering moseying
napping nesting nibbling paddling parading peeking perching pouncing prancing prowling
racing rambling roaming rolling romping rowing running rushing sailing scampering
scooting scurrying shuffling singing skating skipping sledding sliding slinking sneaking
snoozing soaring splashing sprinting spinning stomping strolling strutting sunning
surfing swaying swimming swinging tiptoeing tooting tracking trekking trotting tumbling
twirling waddling wading wandering whistling wiggling yodeling zigzagging zooming basking
burrowing camping canoeing crooning fishing grinning hollering kayaking puttering rafting
roving sauntering stargazing tinkering touring traipsing voyaging whirling`.split(/\s+/);

const ANIMALS = `aardvark alpaca antelope armadillo badger bat bear beaver bison bobcat buffalo
camel caribou cheetah chipmunk cougar coyote crane crow deer dingo dolphin donkey dove duck
eagle egret elk emu falcon ferret finch flamingo fox frog gazelle gecko goat goose gopher
grouse hare hawk hedgehog heron hippo horse hummingbird ibex iguana jackrabbit jaguar jay
kangaroo kestrel kingfisher koala lemur leopard lizard llama lobster lynx magpie mallard
manatee marmot marten meerkat mink moose mouse mule narwhal newt ocelot octopus opossum
oriole osprey otter owl panda panther parrot pelican penguin pheasant pika platypus
porcupine possum puffin puma quail rabbit raccoon raven reindeer roadrunner robin salmon
seal shark sheep skunk sloth sparrow squirrel stork swan tapir tortoise toucan trout
turkey turtle walrus warbler weasel whale wolf wombat woodchuck woodpecker yak zebra`.split(/\s+/);

const pick = (list) => list[crypto.randomInt(list.length)];

export function randomSlug() {
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(ANIMALS)}`;
}

// Paths the app itself uses at the top level; a map can't take these as its slug.
export const RESERVED = new Set(`api auth login logout join profile admin media img css js state states
healthz well-known favicon robots sitemap new signup signin static assets public map maps
about help privacy terms settings account www root dates`.split(/\s+/));

export function cleanSlug(input) {
  const slug = String(input || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (slug.length < 3 || slug.length > 48) return { error: 'Use 3 to 48 letters, numbers, or dashes.' };
  if (RESERVED.has(slug)) {
    return { error: 'That address is reserved. Try another.' };
  }
  return { slug };
}
