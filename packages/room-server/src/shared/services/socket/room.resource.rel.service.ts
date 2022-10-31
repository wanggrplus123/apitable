import { Injectable } from '@nestjs/common';
import { RedisService } from '@vikadata/nestjs-redis';
import { FieldType, IRemoteChangeset, IResourceRevision, ResourceIdPrefix } from '@apitable/core';
import * as util from 'util';
import { CacheKeys, InjectLogger, REF_STORAGE_EXPIRE_TIME } from '../../common';
import { Logger } from 'winston';
import { difference, intersection, isEmpty } from 'lodash';
import { IClientRoomChangeResult } from './socket.interface';
import { DatasheetRepository } from '../../../database/repositories/datasheet.repository';
import { ResourceMetaRepository } from '../../../database/repositories/resource.meta.repository';
import { WidgetRepository } from '../../../database/repositories/widget.repository';
import { DatasheetMetaService } from 'database/services/datasheet/datasheet.meta.service';
import { ComputeFieldReferenceManager } from 'database/services/datasheet/compute.field.reference.manager';

/**
 * Room - Resource two-way association maintenance
 */
@Injectable()
export class RoomResourceRelService {

  constructor(
    @InjectLogger() private readonly logger: Logger,
    private readonly redisService: RedisService,
    private readonly datasheetMetaService: DatasheetMetaService,
    private readonly computeFieldReferenceManager: ComputeFieldReferenceManager,
    private readonly datasheetRepository: DatasheetRepository,
    private readonly resourceMetaRepository: ResourceMetaRepository,
    private readonly widgetRepository: WidgetRepository,
  ) { }

  async hasResource(roomId: string): Promise<boolean> {
    // Create or update Room - Resource two-way association
    const client = this.redisService.getClient();
    const roomKey = util.format(CacheKeys.ROOM_RELATE, roomId);
    const resourceIds = await client.smembers(roomKey);
    return resourceIds.length > 0;
  }

  async getEffectDatasheetIds(resourceIds: string[]): Promise<string[]> {
    const allEffectResourceIds = new Set<string>();
    for (const resourceId of resourceIds) {
      const roomIds = await this.getDatasheetRoomIds(resourceId, true);
      // Analyze resource, reversely compute the room which the resource belongs to
      if (roomIds.length === 0) {
        const dstIds = await this.reverseComputeDatasheetRoom(resourceId);
        dstIds.forEach(id => allEffectResourceIds.add(id));
        continue;
      }
      roomIds.filter(id => id.startsWith(ResourceIdPrefix.Datasheet))
        .forEach(id => allEffectResourceIds.add(id));
    }
    return Array.from(allEffectResourceIds);
  }

  async getDatasheetRoomIds(resourceId: string, withoutSelf = false): Promise<string[]> {
    const client = this.redisService.getClient();
    const resourceKey = util.format(CacheKeys.RESOURCE_RELATE, resourceId);
    const roomIds = await client.smembers(resourceKey);
    if (!withoutSelf && roomIds.length === 0 && resourceId.startsWith(ResourceIdPrefix.Datasheet)) {
      return [resourceId];
    }
    return roomIds.filter(id => id.startsWith(ResourceIdPrefix.Datasheet)).map(id => id);
  }

  async getDatasheetResourceIds(roomId: string): Promise<string[]> {
    // Create or update Room - Resource two-way association
    const client = this.redisService.getClient();
    const roomKey = util.format(CacheKeys.ROOM_RELATE, roomId);
    const resourceIds = await client.smembers(roomKey);
    if (resourceIds.length === 0 && roomId.startsWith(ResourceIdPrefix.Datasheet)) {
      return [roomId];
    }
    return resourceIds.filter(id => id.startsWith(ResourceIdPrefix.Datasheet)).map(id => id);
  }

  async getResourceRevisions(roomId: string): Promise<IResourceRevision[]> {
    // Create or update Room - Resource two-way association
    const client = this.redisService.getClient();
    const roomKey = util.format(CacheKeys.ROOM_RELATE, roomId);
    const resourceIds = await client.smembers(roomKey);

    // Query the latest revision number of each resource
    const resourceRevisions: IResourceRevision[] = [];
    const dstIds: string[] = [];
    const rscIds: string[] = [];
    const wdtIds: string[] = [];
    resourceIds.forEach(id => {
      switch (id.substring(0, 3)) {
        case ResourceIdPrefix.Datasheet:
          dstIds.push(id);
          break;
        case ResourceIdPrefix.Form:
        case ResourceIdPrefix.Dashboard:
          rscIds.push(id);
          break;
        case ResourceIdPrefix.Widget:
          wdtIds.push(id);
          break;
        default:
          break;
      }
    });
    if (dstIds.length > 0) {
      const datasheetRevisions = await this.datasheetRepository.selectRevisionByDstIds(dstIds);
      resourceRevisions.push(...datasheetRevisions);
    }
    if (rscIds.length > 0) {
      const rscRevisions = await this.resourceMetaRepository.getRevisionByRscIds(rscIds);
      resourceRevisions.push(...rscRevisions);
    }
    if (wdtIds.length > 0) {
      const wdtRevisions = await this.widgetRepository.getRevisionByWdtIds(wdtIds);
      resourceRevisions.push(...wdtRevisions);
    }
    const revisions = resourceRevisions.map(rscRevision => {
      return {
        resourceId: rscRevision.resourceId,
        revision: Number(rscRevision.revision),
      };
    });
    return revisions;
  }

  async createOrUpdateRel(roomId: string, resourceIds: string[]) {
    const client = this.redisService.getClient();
    // Maintain room - resource map
    const roomKey = util.format(CacheKeys.ROOM_RELATE, roomId);
    const exist = await client.exists(roomKey);
    if (exist) {
      this.logger.info(`ROOM ${roomId} exist Room - Resource map`);
      // Room - Resource two-way association exists
      const members = await client.smembers(roomKey);
      // Get difference, compensate missing parts, partial user has no permission, resourceIds may not be loaded all.
      const diff = difference<string>(resourceIds, members);
      if (diff.length > 0) {
        await client.sadd(roomKey, ...diff);
      }
    } else {
      this.logger.info(`New ROOM: ${roomId}'s Room - Resource map`);
      await client.sadd(roomKey, ...resourceIds);
    }
    await client.expire(roomKey, REF_STORAGE_EXPIRE_TIME);

    // Maintain resource - room two-way association
    for (let i = 0; i < resourceIds.length; i++) {
      const resourceKey = util.format(CacheKeys.RESOURCE_RELATE, resourceIds[i]);
      const result = await client.sismember(resourceKey, roomId);
      // Check if room exists in Resource - Room two-way association
      if (!result) {
        this.logger.info(`Room ${roomId} not exist in ${resourceIds[i]} Resource - Room map`);
        await client.sadd(resourceKey, ...[roomId]);
      }
      await client.expire(resourceKey, REF_STORAGE_EXPIRE_TIME);
    }
  }

  async removeRel(roomId: string, removeResourceIds: string[]) {
    // Filter main resource
    const resourceIds = difference<string>(removeResourceIds, [roomId]);
    if (!resourceIds.length) {
      return;
    }
    const client = this.redisService.getClient();
    // Maintain room - resource two-way association
    const roomKey = util.format(CacheKeys.ROOM_RELATE, roomId);
    const exist = await client.exists(roomKey);
    if (exist) {
      this.logger.info(`ROOM ${roomId} exist Room - Resource map`);
      // Room - Resource two-way association exists
      const members = await client.smembers(roomKey);
      // Get intersection, delete Resource that left the Room
      const inter = intersection<string>(resourceIds, members);
      if (inter.length > 0) {
        await client.srem(roomKey, ...inter);
      }
    }

    // Maintain resource - room two-way association
    for (let i = 0; i < resourceIds.length; i++) {
      const resourceKey = util.format(CacheKeys.RESOURCE_RELATE, resourceIds[i]);
      const result = await client.sismember(resourceKey, roomId);
      // Check if room exists in Resource - Room two-way association
      if (result) {
        this.logger.info(`Room ${roomId} exist in ${resourceIds[i]} Resource - Room map`);
        const count = await client.scard(resourceKey);
        if (count === 1) {
          await client.del(resourceKey);
        } else {
          await client.srem(resourceKey, ...[roomId]);
        }
      }
    }
  }

  async getRoomChangeResult(roomId: string, changesets: IRemoteChangeset[]): Promise<IClientRoomChangeResult[]> {
    const beginTime = +new Date();
    this.logger.info('Start loading RoomChangeResult');
    const client = this.redisService.getClient();
    const results: IClientRoomChangeResult[] = [];
    for (const cs of changesets) {
      const resourceKey = util.format(CacheKeys.RESOURCE_RELATE, cs.resourceId);
      let roomIds = await client.smembers(resourceKey);
      // If Resource does not exist in any Room, fill in Resource - Room two-way association
      if (roomIds.length === 0) {
        roomIds = [roomId];
        await client.sadd(resourceKey, ...roomIds);
      } else if (!roomIds.includes(roomId)) {
        // Make sure RemoteChange is returned to the current Room
        roomIds.push(roomId);
      }
      results.push({ changeset: cs, roomIds });
    }
    const endTime = +new Date();
    this.logger.info(`Finished loading RoomChangeResult, duration: ${endTime - beginTime}ms`);
    return results;
  }

  /**
   * Compute datasheet room reversely
   */
  async reverseComputeDatasheetRoom(dstId: string) {
    // Obtain meta of the datasheet
    const meta = await this.datasheetMetaService.getMetaDataByDstId(dstId);
    // Filter loading linked datasheet
    const foreignDatasheetIdToFiledIdsMap = new Map<string, string[]>();
    Object.values(meta.fieldMap).filter(field => field.type === FieldType.Link)
      .forEach(field => {
        const { foreignDatasheetId, brotherFieldId } = field.property;
        // Filter out self linking
        if (!foreignDatasheetId || foreignDatasheetId === dstId) {
          return;
        }
        if (foreignDatasheetIdToFiledIdsMap.has(foreignDatasheetId)) {
          foreignDatasheetIdToFiledIdsMap.get(foreignDatasheetId).push(brotherFieldId);
        } else {
          foreignDatasheetIdToFiledIdsMap.set(foreignDatasheetId, [brotherFieldId]);
        }
      });
    // Save resource references of room of the datasheet asynchronously
    const dstIds = [dstId, ...Array.from(foreignDatasheetIdToFiledIdsMap.keys())];
    this.createOrUpdateRel(dstId, dstIds);
    // No linked datasheet, only the datasheet is in the room, finish
    if (foreignDatasheetIdToFiledIdsMap.size === 0) {
      return dstIds;
    }

    // Linked datasheet exists, needs check if the linked datasheet of the linked datasheet references the datasheet
    for (const [foreignDatasheetId, linkFieldIds] of foreignDatasheetIdToFiledIdsMap) {
      // Query meta of linked datasheet
      const foreignDatasheetMeta = await this.datasheetMetaService.getMetaDataByDstId(foreignDatasheetId);

      // Check if there are other linked datasheets
      const field = Object.values(foreignDatasheetMeta.fieldMap).find(field => field.type === FieldType.Link
        && !dstIds.includes(field.property.foreignDatasheetId));
      if (!field) {
        continue;
      }

      // Check if LookUp reference exists
      const lookUpFieldIds = Object.values(foreignDatasheetMeta.fieldMap)
        .filter(field => field.type === FieldType.LookUp && linkFieldIds.includes(field.property.relatedLinkFieldId))
        .map(field => {
          return field.id;
        });
      // Influenced fields of linked datasheet. Link + LookUp + Formula
      const effectFieldIds = lookUpFieldIds.length > 0 ? [...linkFieldIds, ...lookUpFieldIds] : linkFieldIds;
      // Check if Formula reference exists
      const formulaFieldIds = Object.values(foreignDatasheetMeta.fieldMap)
        .filter(field => field.type === FieldType.Formula)
        .map(field => {
          // Extract formula expression, if it references fields
          const formulaRefFieldIds = field.property?.expression.match(/fld\w{10}/g);
          // return type of String.match may be null or empty array
          if (!formulaRefFieldIds || isEmpty(formulaRefFieldIds)) {
            return null;
          }
          // Get intersection, if not empty, it means this formula field references influenced Link or LookUp field,
          // thus the field is influenced.
          const inter = intersection<string>(formulaRefFieldIds, effectFieldIds);
          return inter.length > 0 ? field.id : null;
        }).filter(Boolean);
      formulaFieldIds.length && effectFieldIds.push(...formulaFieldIds);

      // Read field inverse reference relation, trace influenced linked datasheet upward
      await this.circleFindRelDatasheet(foreignDatasheetId, effectFieldIds, dstIds);
    }

    return dstIds;
  }

  private async circleFindRelDatasheet(dstId: string, effectFieldIds: string[], allEffectDstIds: string[]) {
    for (const fieldId of effectFieldIds) {
      const dstIdToFiledIdsMap = await this.computeFieldReferenceManager.getReRefDstToFieldMap(dstId, fieldId);
      if (!dstIdToFiledIdsMap) {
        continue;
      }
      for (const [datasheetId, fieldIds] of dstIdToFiledIdsMap) {
        if (allEffectDstIds.includes(datasheetId)) {
          continue;
        }
        allEffectDstIds.push(datasheetId);
        await this.circleFindRelDatasheet(datasheetId, fieldIds, allEffectDstIds);
      }
    }
  }
}
