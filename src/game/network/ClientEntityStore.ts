import type { Entity } from '../sim/types';
import { IndexedEntityIdMap } from './IndexedEntityIdCollections';

export class ClientEntityStore extends IndexedEntityIdMap<Entity> {}
