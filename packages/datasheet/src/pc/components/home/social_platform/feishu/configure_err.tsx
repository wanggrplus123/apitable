import { ConfigConstant, Settings, Strings, t } from '@apitable/core';
import { navigationToUrl } from 'pc/components/route_manager/navigation_to_url';
import { useQuery } from 'pc/hooks';
import { useMemo } from 'react';
import BoundImage from 'static/icon/common/common_img_feishu_binding.png';
import FailureImage from 'static/icon/common/common_img_share_linkfailure.png';
import { ErrPromptBase, IErrPromptBase } from 'pc/components/home/social_platform/components/err_prompt_base';
import { SocialPlatformMap } from '../config';

const FeishuConfigureErr = () => {
  const query = useQuery();
  const key = query.get('key');

  const dataInfo: IErrPromptBase = useMemo(() => {
    switch (key) {
      case 'auth_fail' : {
        return {
          img: BoundImage,
          desc: t(Strings.feishu_configure_of_authorize_err),
          btnText: t(Strings.entry_space),
          onClick: () => {
            navigationToUrl(Settings.integration_feishu_help.value);
          },
        };
      }
      case 'is_not_admin': {
        return {
          img: FailureImage,
          desc: t(Strings.feishu_configure_of_idetiity_err),
          btnText: t(Strings.know_more),
          onClick: () => {
            navigationToUrl(Settings.integration_feishu_help.value);
          },
        };
      }
      default: {
        return {
          img: FailureImage,
          desc: t(Strings.something_went_wrong),
          btnText: t(Strings.know_more),
          onClick: () => {
            navigationToUrl(Settings.integration_feishu_help.value);
          },
        };
      }
    }
  }, [key]);

  return (
    <ErrPromptBase
      headerLogo={SocialPlatformMap[ConfigConstant.SocialType.FEISHU].logoWithVika as string}
      {...dataInfo}
    />
  );
};

export default FeishuConfigureErr;
