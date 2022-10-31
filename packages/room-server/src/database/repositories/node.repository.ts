import { NodeEntity } from '../entities/node.entity';
import { INodeExtra } from '../../shared/interfaces';
import { EntityRepository, Repository } from 'typeorm';

@EntityRepository(NodeEntity)
export class NodeRepository extends Repository<NodeEntity> {

  /**
   * Obtain the number of nodes with the given node ID
   */
  selectCountByNodeId(nodeId: string): Promise<number> {
    return this.count({ where: { nodeId, isRubbish: false }});
  }

  /**
   * Obtain the number of templates with the given node ID
   */
  selectTemplateCountByNodeId(nodeId: string): Promise<number> {
    return this.count({ where: { nodeId, isTemplate: true, isRubbish: false }});
  }

  /**
   * Obtain the number of nodes with the given parent node ID
   */
  selectCountByParentId(parentId: string): Promise<number> {
    return this.count({ where: { parentId, isRubbish: false }});
  }

  /**
   * Obtain the ID of the space which the given node belongs to
   */
  selectSpaceIdByNodeId(nodeId: string): Promise<{ spaceId: string } | undefined> {
    return this.createQueryBuilder('vn')
      .select('vn.space_id', 'spaceId')
      .where('vn.node_id = :nodeId', { nodeId })
      .andWhere('vn.is_rubbish = 0')
      .getRawOne<{ spaceId: string }>();
  }

  /**
   * Obtain the children node list of a given node
   */
  async selectAllSubNodeIds(nodeId: string): Promise<string[]> {
    const raws = await this.query(
      `
          WITH RECURSIVE sub_ids (node_id) AS
          (
            SELECT node_id
            FROM vika_node
            WHERE parent_id = ? and is_rubbish = 0
            UNION ALL
            SELECT c.node_id
            FROM sub_ids AS cp
            JOIN vika_node AS c ON cp.node_id = c.parent_id and c.is_rubbish = 0
          )
          SELECT distinct node_id nodeId
          FROM sub_ids;
        `,
      [nodeId],
    );
    return raws.reduce((pre: string[], cur: { nodeId: string; }) => {
      pre.push(cur.nodeId);
      return pre;
    }, []);
  }

  /**
   * Obtain the path to the root node of a given node.
   * 
   * The returned node ID array includes the given node and does not include the root node.
   * 
   * Example: for a path of 3 nodes, the returned array is `[nodeId, parentId, grandparentId, great-grandparentId]`
   */
  async selectParentPathByNodeId(nodeId: string): Promise<string[]> {
    // Query the path with recursive SQL, the result set includes the given node.
    const raws = await this.query(
      `
          WITH RECURSIVE parent_view (node_id, node_name, parent_id, lvl) AS
          (
            SELECT n.node_id, n.node_name, n.parent_id, 0 lvl
            FROM vika_node n
            WHERE n.node_id = ? AND n.is_rubbish = 0
            UNION ALL
            SELECT c.node_id, c.node_name, c.parent_id, pv.lvl + 1
            FROM parent_view AS pv
            JOIN vika_node AS c ON pv.parent_id = c.node_id AND c.is_rubbish = 0
          )
          SELECT node_id nodeId
          FROM parent_view
          WHERE parent_id != '0'
          ORDER BY lvl ASC
        `,
      [nodeId],
    );
    return raws.reduce((pre: string[], cur: { nodeId: string; }) => {
      pre.push(cur.nodeId);
      return pre;
    }, []);
  }

  getNodeInfo(nodeId: string): Promise<NodeEntity | undefined> {
    return this.findOne({
      select: ['nodeId', 'nodeName', 'spaceId', 'parentId', 'icon', 'extra', 'type'],
      where: [{ nodeId, isRubbish: false }],
    });
  }

  selectExtraByNodeId(nodeId: string): Promise<{ extra: INodeExtra }> {
    return this.createQueryBuilder('vn')
      .select('CONVERT(vn.extra, JSON) as extra')
      .where('vn.node_id = :nodeId', { nodeId })
      .andWhere('vn.is_rubbish = 0')
      .getRawOne();
  }
}
