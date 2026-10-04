import React from 'react';
import {Composition} from 'remotion';
import {ThailandRankingVideo} from './video/ThailandRankingVideo';
import {sampleProject} from './data/sample';
import {buildTimeline} from './timeline/buildTimeline';

export const Root: React.FC = () => {
  const timeline = buildTimeline(sampleProject);
  return (
    <Composition
      id="ThailandProvinceRanking"
      component={ThailandRankingVideo}
      width={1080}
      height={1920}
      fps={sampleProject.fps ?? 30}
      durationInFrames={timeline.totalFrames}
      defaultProps={{project: sampleProject}}
    />
  );
};
