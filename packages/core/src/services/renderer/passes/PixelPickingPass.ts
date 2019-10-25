import { inject, injectable } from 'inversify';
import { lazyInject } from '../../../index';
import { TYPES } from '../../../types';
import {
  IInteractionService,
  InteractionEvent,
} from '../../interaction/IInteractionService';
import { ILayer, ILayerService } from '../../layer/ILayerService';
import { ILogService } from '../../log/ILogService';
import { gl } from '../gl';
import { IFramebuffer } from '../IFramebuffer';
import { IPass, PassType } from '../IMultiPassRenderer';
import { IRendererService } from '../IRendererService';

function decodePickingColor(color: Uint8Array): number {
  const [i1, i2, i3] = color;
  // 1 was added to seperate from no selection
  const index = i1 + i2 * 256 + i3 * 65536 - 1;
  return index;
}

/**
 * color-based PixelPickingPass
 * @see https://github.com/antvis/L7/blob/next/dev-docs/PixelPickingEngine.md
 */
@injectable()
export default class PixelPickingPass implements IPass {
  @lazyInject(TYPES.IRendererService)
  protected readonly rendererService: IRendererService;

  @lazyInject(TYPES.IInteractionService)
  protected readonly interactionService: IInteractionService;

  @lazyInject(TYPES.ILogService)
  protected readonly logger: ILogService;

  /**
   * picking framebuffer，供 attributes 颜色编码后输出
   */
  private pickingFBO: IFramebuffer;

  /**
   * 保存 layer 引用
   */
  private layer: ILayer;

  /**
   * 简单的 throttle，防止连续触发 hover 时导致频繁渲染到 picking framebuffer
   */
  private alreadyInRendering: boolean = false;

  public getType() {
    return PassType.Normal;
  }

  public init(layer: ILayer) {
    this.layer = layer;
    const { createTexture2D, createFramebuffer } = this.rendererService;

    // 创建 picking framebuffer，后续实时 resize
    this.pickingFBO = createFramebuffer({
      color: createTexture2D({
        width: 1,
        height: 1,
        wrapS: gl.CLAMP_TO_EDGE,
        wrapT: gl.CLAMP_TO_EDGE,
      }),
    });

    // 监听 hover 事件
    this.interactionService.on(InteractionEvent.Hover, this.pickFromPickingFBO);
  }

  public render(layer: ILayer) {
    if (this.alreadyInRendering) {
      return;
    }

    const { getViewportSize, useFramebuffer, clear } = this.rendererService;
    const { width, height } = getViewportSize();

    // throttled
    this.alreadyInRendering = true;

    // resize first, fbo can't be resized in use
    this.pickingFBO.resize({ width, height });

    useFramebuffer(this.pickingFBO, () => {
      clear({
        framebuffer: this.pickingFBO,
        color: [0, 0, 0, 0],
        stencil: 0,
        depth: 1,
      });

      this.logger.info(`picking fbo cleared ${width} ${height}`);

      /**
       * picking pass 不需要 multipass，原因如下：
       * 1. 已经 clear，无需 ClearPass
       * 2. 只需要 RenderPass
       * 3. 后处理 pass 需要跳过
       */
      const originRenderFlag = this.layer.multiPassRenderer.getRenderFlag();
      this.layer.multiPassRenderer.setRenderFlag(false);
      // trigger hooks
      layer.hooks.beforeRender.call(layer);
      layer.render();
      layer.hooks.afterRender.call(layer);
      this.layer.multiPassRenderer.setRenderFlag(originRenderFlag);

      this.alreadyInRendering = false;
    });
  }

  /**
   * 拾取视口指定坐标属于的要素
   * TODO：支持区域拾取
   */
  private pickFromPickingFBO = ({ x, y }: { x: number; y: number }) => {
    const {
      getViewportSize,
      readPixels,
      useFramebuffer,
    } = this.rendererService;
    const { width, height } = getViewportSize();
    const { enableHighlight } = this.layer.getStyleOptions();

    let pickedColors: Uint8Array | undefined;
    useFramebuffer(this.pickingFBO, () => {
      // avoid realloc
      pickedColors = readPixels({
        x: Math.round(x * window.devicePixelRatio),
        // 视口坐标系原点在左上，而 WebGL 在左下，需要翻转 Y 轴
        y: Math.round(height - (y + 1) * window.devicePixelRatio),
        width: 1,
        height: 1,
        data: new Uint8Array(1 * 1 * 4),
        framebuffer: this.pickingFBO,
      });

      this.logger.info('try to picking');

      if (
        pickedColors[0] !== 0 ||
        pickedColors[1] !== 0 ||
        pickedColors[2] !== 0
      ) {
        this.logger.info('picked');
        const pickedFeatureIdx = decodePickingColor(pickedColors);
        const rawFeature = this.layer.getSource()?.data?.dataArray[
          pickedFeatureIdx
        ];

        // trigger onHover/Click callback on layer
        this.triggerHoverOnLayer({ x, y, feature: rawFeature });
      }
    });

    if (enableHighlight) {
      this.highlightPickedFeature(pickedColors);
    }
  };

  private triggerHoverOnLayer({
    x,
    y,
    feature,
  }: {
    x: number;
    y: number;
    feature: unknown;
  }) {
    // TODO: onClick
    const { onHover, onClick } = this.layer.getStyleOptions();
    if (onHover) {
      onHover({
        x,
        y,
        feature,
      });
    }
  }

  /**
   * highlight 如果直接修改选中 feature 的 buffer，存在两个问题：
   * 1. 鼠标移走时无法恢复
   * 2. 无法实现高亮颜色与原始原色的 alpha 混合
   * 因此高亮还是放在 shader 中做比较好
   * @example
   * this.layer.color('name', ['#000000'], {
   *  featureRange: {
   *    startIndex: pickedFeatureIdx,
   *    endIndex: pickedFeatureIdx + 1,
   *  },
   * });
   */
  private highlightPickedFeature(pickedColors: Uint8Array | undefined) {
    const [r, g, b] = pickedColors;

    // TODO: highlight pass 需要 multipass
    const originRenderFlag = this.layer.multiPassRenderer.getRenderFlag();
    this.layer.multiPassRenderer.setRenderFlag(false);
    this.layer.hooks.beforeRender.call(this.layer);
    // @ts-ignore
    this.layer.hooks.beforeHighlight.call(this.layer, [r, g, b]);
    this.layer.render();
    this.layer.hooks.afterHighlight.call(this.layer);
    this.layer.hooks.afterRender.call(this.layer);
    this.layer.multiPassRenderer.setRenderFlag(originRenderFlag);
  }
}
