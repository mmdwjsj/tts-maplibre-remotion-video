import React from 'react';
import {Composition} from 'remotion';
import {ThailandRankingVideo} from './video/ThailandRankingVideo';
import {sampleProject} from './data/sample';
import {buildTimeline} from './timeline/buildTimeline';
import type {ProjectData} from './types';

export const Root: React.FC = () => {
  return (
    <Composition
      id="ThailandProvinceRanking"
      component={ThailandRankingVideo}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={300}
      defaultProps={{project: sampleProject}}
      calculateMetadata={({props}) => {
        const project = (props as {project?: ProjectData}).project ?? sampleProject;
        const timeline = buildTimeline(project);

        return {
          fps: project.fps ?? 30,
          durationInFrames: timeline.totalFrames,
          props: {project},
        };
      }}
    />
  );
};